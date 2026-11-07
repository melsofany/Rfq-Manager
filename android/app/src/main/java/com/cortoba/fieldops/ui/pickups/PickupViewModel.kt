package com.cortoba.fieldops.ui.pickups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupDetailResponse
import com.cortoba.fieldops.core.network.dto.PickupListResponse
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PickupListUiState(
    val loading: Boolean = true,
    val data: PickupListResponse? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
    val cachedAt: Long? = null,
)

data class PickupDetailUiState(
    val loading: Boolean = true,
    val data: PickupDetailResponse? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
    val cachedAt: Long? = null,
    /** Group keys the representative expanded to see the PO allocation. */
    val expanded: Set<String> = emptySet(),
)

/** State of the receiving form itself. */
data class ReceiptFormState(
    val entries: List<ReceiptEntry> = emptyList(),
    val notes: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    /** Non-null once the server (or the outbox) accepted the submission. */
    val result: ReceiptSubmitResult? = null,
    /** Assignment the entries were seeded from — makes seeding idempotent. */
    val seededFor: Int? = null,
)

data class ReceiptSubmitResult(
    val queuedOffline: Boolean,
    val duplicate: Boolean,
    val acceptedQty: Double,
    val missingQty: Double,
    /** True when the server recorded less than the ordered quantity. */
    val partial: Boolean = false,
)

@HiltViewModel
class PickupViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _list = MutableStateFlow(PickupListUiState())
    val list: StateFlow<PickupListUiState> = _list.asStateFlow()

    private val _detail = MutableStateFlow(PickupDetailUiState())
    val detail: StateFlow<PickupDetailUiState> = _detail.asStateFlow()

    private val _form = MutableStateFlow(ReceiptFormState())
    val form: StateFlow<ReceiptFormState> = _form.asStateFlow()

    fun loadList() {
        _list.update { it.copy(loading = it.data == null, error = null) }
        viewModelScope.launch {
            try {
                val result = repository.pickups()
                _list.update {
                    it.copy(
                        loading = false,
                        data = result.value,
                        fromCache = result.fromCache,
                        cachedAt = result.cachedAt,
                    )
                }
            } catch (e: ApiException) {
                _list.update { it.copy(loading = false, error = e.userMessage) }
            }
        }
    }

    fun loadDetail(assignmentId: Int) {
        _detail.update { it.copy(loading = it.data == null, error = null) }
        viewModelScope.launch {
            try {
                val result = repository.pickupDetail(assignmentId)
                _detail.update {
                    it.copy(
                        loading = false,
                        data = result.value,
                        fromCache = result.fromCache,
                        cachedAt = result.cachedAt,
                    )
                }
                seedForm(assignmentId, result.value)
            } catch (e: ApiException) {
                _detail.update { it.copy(loading = false, error = e.userMessage) }
            }
        }
    }

    /**
     * Seed the receiving form from the loaded task.
     *
     * Called from [loadDetail] once the task has actually arrived, never from a
     * sibling call in the screen: `loadDetail` is asynchronous, so a separate
     * `prepareForm()` fired alongside it reads `_detail` while it is still empty
     * and leaves the form with zero rows — the representative then sees
     * «لا توجد أصناف للاستلام» and can never confirm anything.
     */
    private fun seedForm(assignmentId: Int, detail: PickupDetailResponse) {
        _form.update { current ->
            // Re-seeding would discard quantities the rep has already typed.
            if (current.seededFor == assignmentId && current.entries.isNotEmpty()) return@update current
            current.copy(
                entries = detail.items.flatMap { group -> group.toEntries() },
                error = null,
                result = null,
                seededFor = assignmentId,
            )
        }
    }

    fun toggleGroup(groupKey: String) {
        _detail.update { current ->
            val next = current.expanded.toMutableSet()
            if (!next.add(groupKey)) next.remove(groupKey)
            current.copy(expanded = next)
        }
    }

    /**
     * Running totals for the confirmation summary. Computed from what the
     * representative actually typed, never from a local assumption about what
     * "should" have arrived.
     */
    fun summaryFor(entries: List<ReceiptEntry>): ReceiptSummary {
        val detail = _detail.value.data ?: return ReceiptSummary()
        val required = detail.items.sumOf { it.totalRemainingQty }
        val received = entries.sumOf { it.receivedQty.toDoubleOrNull() ?: 0.0 }
        val rejected = entries.sumOf { it.rejectedQty.toDoubleOrNull() ?: 0.0 }
        val accepted = entries.sumOf {
            (it.receivedQty.toDoubleOrNull() ?: 0.0) - (it.rejectedQty.toDoubleOrNull() ?: 0.0)
        }
        return ReceiptSummary(
            distinctItems = detail.items.size,
            totalRequired = required,
            totalReceived = received,
            totalRejected = rejected,
            totalAccepted = accepted.coerceAtLeast(0.0),
            totalMissing = (required - received).coerceAtLeast(0.0),
        )
    }

    // ── Receiving form ────────────────────────────────────────────────────

    fun onReceivedQtyChange(poItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.poItemId == poItemId) it.copy(receivedQty = sanitizeNumber(value)) else it
                },
                error = null,
            )
        }
    }

    fun onRejectedQtyChange(poItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.poItemId == poItemId) it.copy(rejectedQty = sanitizeNumber(value)) else it
                },
                error = null,
            )
        }
    }

    fun onRejectionReasonChange(poItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.poItemId == poItemId) it.copy(rejectionReason = value) else it
                },
            )
        }
    }

    fun onNotesChange(value: String) = _form.update { it.copy(notes = value) }

    /** «استلام كامل» on one line: fill the received quantity with the required one. */
    fun fillFullQuantity(poItemId: Int) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.poItemId == poItemId) {
                        it.copy(
                            receivedQty = com.cortoba.fieldops.core.util.formatQty(it.requiredQty),
                            rejectedQty = "",
                        )
                    } else {
                        it
                    }
                },
                error = null,
            )
        }
    }

    /** «لم يُستلم» on one line: zero received, the full quantity is missing. */
    fun markNotReceived(poItemId: Int) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.poItemId == poItemId) it.copy(receivedQty = "0", rejectedQty = "") else it
                },
                error = null,
            )
        }
    }

    /** «استلام الكل»: fill every line with its full required quantity. */
    fun fillAllFullQuantity() {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    it.copy(
                        receivedQty = com.cortoba.fieldops.core.util.formatQty(it.requiredQty),
                        rejectedQty = "",
                    )
                },
                error = null,
            )
        }
    }

    /** «رفض الكل»: mark every line as not received. */
    fun rejectAll() {
        _form.update { state ->
            state.copy(
                entries = state.entries.map { it.copy(receivedQty = "0", rejectedQty = "") },
                error = null,
            )
        }
    }

    fun submit(assignmentId: Int) {
        val entries = _form.value.entries
        if (entries.isEmpty()) {
            _form.update { it.copy(error = "لا توجد أصناف للاستلام") }
            return
        }

        // Validate locally so an obviously bad number never reaches the server
        // and, worse, never sits in the outbox failing forever.
        for (entry in entries) {
            val received = entry.receivedQty.toDoubleOrNull()
            if (received == null || received < 0) {
                _form.update { it.copy(error = "أدخل كمية صحيحة لكل صنف") }
                return
            }
            val rejected = entry.rejectedQty.toDoubleOrNull() ?: 0.0
            if (rejected < 0 || rejected > received) {
                _form.update { it.copy(error = "الكمية التالفة لا يمكن أن تتجاوز الكمية المستلمة") }
                return
            }
            if (received > entry.requiredQty) {
                _form.update {
                    it.copy(
                        error = "الكمية المستلمة أكبر من المطلوبة في أحد الأصناف " +
                            "(${entry.displayName})",
                    )
                }
                return
            }
        }

        val summary = summaryFor(entries)
        _form.update { it.copy(submitting = true, error = null) }

        viewModelScope.launch {
            try {
                val request = com.cortoba.fieldops.core.network.dto.ReceiptConfirmRequest(
                    items = entries.map { entry ->
                        val received = entry.receivedQty.toDoubleOrNull() ?: 0.0
                        val rejected = entry.rejectedQty.toDoubleOrNull() ?: 0.0
                        com.cortoba.fieldops.core.network.dto.ReceiptItemRequest(
                            poItemId = entry.poItemId,
                            receivedQty = received,
                            // Accepted is what is NOT damaged. The server records
                            // both so the damaged units stay visible.
                            acceptedQty = (received - rejected).coerceAtLeast(0.0),
                            rejectedQty = rejected,
                            rejectionReason = entry.rejectionReason.takeIf { it.isNotBlank() },
                            notes = entry.notes.takeIf { it.isNotBlank() },
                        )
                    },
                    clientUuid = java.util.UUID.randomUUID().toString(),
                    gps = com.cortoba.fieldops.core.location.LocationProvider.lastKnown(),
                )
                val outcome = repository.confirmReceipt(assignmentId, request)
                _form.update {
                    it.copy(
                        submitting = false,
                        result = ReceiptSubmitResult(
                            queuedOffline = outcome.fromCache,
                            duplicate = outcome.value.duplicate,
                            acceptedQty = summary.totalAccepted,
                            missingQty = summary.totalMissing,
                            // Trust the server's status: it knows the accepted
                            // quantities AND the sibling lines the client cannot
                            // see. Falling back to the local shortfall keeps an
                            // offline queue (no server status) sensible.
                            partial = outcome.value.assignmentStatus
                                ?.equals("partially_received", ignoreCase = true)
                                ?: (summary.totalMissing > 0.0),
                        ),
                    )
                }
            } catch (e: ApiException) {
                _form.update { it.copy(submitting = false, error = e.userMessage) }
            }
        }
    }

    private fun sanitizeNumber(raw: String): String {
        // Keep only digits and one decimal separator so a stray Arabic numeral
        // or a comma never produces an unparsable quantity.
        val normalized = raw
            .replace('٠', '0').replace('١', '1').replace('٢', '2').replace('٣', '3')
            .replace('٤', '4').replace('٥', '5').replace('٦', '6').replace('٧', '7')
            .replace('٨', '8').replace('٩', '9')
            .replace('،', '.').replace(',', '.')
        val filtered = normalized.filter { it.isDigit() || it == '.' }
        val firstDot = filtered.indexOf('.')
        return if (firstDot < 0) {
            filtered
        } else {
            filtered.substring(0, firstDot + 1) + filtered.substring(firstDot + 1).replace(".", "")
        }
    }
}

data class ReceiptSummary(
    val distinctItems: Int = 0,
    val totalRequired: Double = 0.0,
    val totalReceived: Double = 0.0,
    val totalRejected: Double = 0.0,
    val totalAccepted: Double = 0.0,
    val totalMissing: Double = 0.0,
)

/**
 * One editable row in the receiving form, keyed by the ORIGINAL po item id.
 *
 * The representative sees a consolidated product, but the quantity they type is
 * applied to the individual PO lines behind it — that is what preserves
 * traceability when the server records the receipt.
 */
data class ReceiptEntry(
    val poItemId: Int,
    val groupKey: String,
    val displayName: String,
    val requiredQty: Double,
    val receivedQty: String,
    val rejectedQty: String = "",
    val notes: String = "",
    val rejectionReason: String = "",
)

/** Flatten a consolidated group into its per-PO-line entries. */
fun ConsolidatedItem.toEntries(): List<ReceiptEntry> =
    allocations.map { allocation ->
        ReceiptEntry(
            poItemId = allocation.poItemId,
            groupKey = groupKey,
            displayName = displayName,
            requiredQty = allocation.remainingQty,
            receivedQty = com.cortoba.fieldops.core.util.formatQty(allocation.remainingQty),
        )
    }
