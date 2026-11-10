package com.cortoba.fieldops.ui.pickups

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupDetailResponse
import com.cortoba.fieldops.core.network.dto.PickupListResponse
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmRequest
import com.cortoba.fieldops.core.network.dto.ReceiptItemRequest
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import com.cortoba.fieldops.core.util.formatQty
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
    val submitting: Boolean = false,
    val error: String? = null,
    /** Assignment the entries were seeded from — makes seeding idempotent. */
    val seededFor: Int? = null,
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

    fun loadDetail(assignmentId: Int, forceReseed: Boolean = false) {
        if (forceReseed) _form.update { it.copy(seededFor = null) }
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

    /**
     * «استلام كلي» on one line: receive its whole remaining quantity — and send
     * it to the server at once. There is no separate confirm step; the tap IS
     * the confirmation.
     */
    fun receiveLineFull(assignmentId: Int, poItemId: Int) = sendLine(
        assignmentId,
        poItemId,
        received = _form.value.entries.firstOrNull { it.poItemId == poItemId }?.requiredQty ?: 0.0,
        rejected = 0.0,
        reason = null,
    )

    /**
     * «رفض» on one line: record nothing received and the whole quantity
     * rejected, with the mandatory reason, at once.
     */
    fun rejectLine(assignmentId: Int, poItemId: Int) {
        val entry = _form.value.entries.firstOrNull { it.poItemId == poItemId } ?: return
        val reason = entry.rejectionReason.trim()
        if (reason.isBlank()) {
            _form.update { it.copy(error = "اختر سبب الرفض أولاً") }
            return
        }
        sendLine(assignmentId, poItemId, received = 0.0, rejected = entry.requiredQty, reason = reason)
    }

    /**
     * «استلام جزئي»: send the quantity the rep typed for this line. Validated
     * here so a bad number never reaches the server or the outbox.
     */
    fun receiveLinePartial(assignmentId: Int, poItemId: Int) {
        val entry = _form.value.entries.firstOrNull { it.poItemId == poItemId } ?: return
        val received = entry.receivedQty.toDoubleOrNull()
        if (received == null || received < 0) {
            _form.update { it.copy(error = "أدخل كمية صحيحة") }
            return
        }
        val rejected = entry.rejectedQty.toDoubleOrNull() ?: 0.0
        if (rejected < 0 || rejected > received) {
            _form.update { it.copy(error = "الكمية التالفة لا يمكن أن تتجاوز الكمية المستلمة") }
            return
        }
        if (received > entry.requiredQty + 1e-6) {
            _form.update { it.copy(error = "الكمية المستلمة أكبر من المطلوبة") }
            return
        }
        if (received <= 1e-6 && rejected <= 1e-6) {
            _form.update { it.copy(error = "أدخل الكمية المستلمة أو استخدم «رفض»") }
            return
        }
        sendLine(
            assignmentId,
            poItemId,
            received = received,
            rejected = rejected,
            reason = entry.rejectionReason.takeIf { it.isNotBlank() },
        )
    }

    /** «استلام الكل»: receive every line of this task in one submission. */
    fun receiveAll(assignmentId: Int) {
        val entries = _form.value.entries
        if (entries.isEmpty()) {
            _form.update { it.copy(error = "لا توجد أصناف للاستلام") }
            return
        }
        sendLines(
            assignmentId,
            entries.map { it.copy(receivedQty = formatQty(it.requiredQty), rejectedQty = "") },
        )
    }

    /** «رفض الكل»: reject every line of this task, with one reason for all. */
    fun rejectAll(assignmentId: Int, reason: String) {
        val entries = _form.value.entries
        if (entries.isEmpty()) {
            _form.update { it.copy(error = "لا توجد أصناف للاستلام") }
            return
        }
        if (reason.isBlank()) {
            _form.update { it.copy(error = "اختر سبب الرفض أولاً") }
            return
        }
        sendLines(
            assignmentId,
            entries.map { it.copy(receivedQty = "0", rejectedQty = "", rejectionReason = reason) },
        )
    }

    /** Send ONE line's receipt and refresh the task afterwards. */
    private fun sendLine(
        assignmentId: Int,
        poItemId: Int,
        received: Double,
        rejected: Double,
        reason: String?,
    ) {
        val entry = _form.value.entries.firstOrNull { it.poItemId == poItemId } ?: return
        _form.update {
            it.copy(
                entries = it.entries.map { e ->
                    if (e.poItemId == poItemId) {
                        e.copy(
                            receivedQty = formatQty(received),
                            rejectedQty = if (rejected > 0) formatQty(rejected) else "",
                            rejectionReason = reason ?: "",
                        )
                    } else {
                        e
                    }
                },
                submitting = true,
                error = null,
            )
        }
        val items = listOf(
            ReceiptItemRequest(
                poItemId = entry.poItemId,
                receivedQty = received,
                acceptedQty = (received - rejected).coerceAtLeast(0.0),
                rejectedQty = rejected,
                rejectionReason = reason,
                notes = null,
            ),
        )
        confirm(assignmentId, items)
    }

    /** Send a whole set of lines (all-of-task actions) and refresh afterwards. */
    private fun sendLines(assignmentId: Int, entries: List<ReceiptEntry>) {
        val items = entries.map { e ->
            val received = e.receivedQty.toDoubleOrNull() ?: 0.0
            val rejected = e.rejectedQty.toDoubleOrNull() ?: 0.0
            ReceiptItemRequest(
                poItemId = e.poItemId,
                receivedQty = received,
                acceptedQty = (received - rejected).coerceAtLeast(0.0),
                rejectedQty = rejected,
                rejectionReason = e.rejectionReason.takeIf { it.isNotBlank() },
                notes = null,
            )
        }
        _form.update { it.copy(entries = entries, submitting = true, error = null) }
        confirm(assignmentId, items)
    }

    /**
     * POST the submission and reload the task so the screen reflects the server
     * truth: a settled line disappears, the rest stay.
     */
    private fun confirm(assignmentId: Int, items: List<ReceiptItemRequest>) {
        viewModelScope.launch {
            try {
                val request = ReceiptConfirmRequest(
                    items = items,
                    clientUuid = java.util.UUID.randomUUID().toString(),
                    gps = com.cortoba.fieldops.core.location.LocationProvider.lastKnown(),
                )
                val outcome = repository.confirmReceipt(assignmentId, request)
                _form.update { it.copy(submitting = false, error = null) }
                // Re-read the task: the server has already dropped the settled
                // lines, so this is what makes the row disappear immediately.
                loadDetail(assignmentId, forceReseed = true)
                if (outcome.fromCache) {
                    _form.update { it.copy(error = "لا يوجد اتصال — تم الحفظ وسيُرسل تلقائياً") }
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
    /** Supplier PO number this line belongs to, for the per-line header. */
    val poNo: String,
    val requiredQty: Double,
    val receivedQty: String,
    val rejectedQty: String = "",
    val rejectionReason: String = "",
)

/** Flatten a consolidated group into its per-PO-line entries. */
fun ConsolidatedItem.toEntries(): List<ReceiptEntry> =
    allocations.map { allocation ->
        ReceiptEntry(
            poItemId = allocation.poItemId,
            groupKey = groupKey,
            displayName = displayName,
            poNo = allocation.poNo,
            requiredQty = allocation.remainingQty,
            receivedQty = com.cortoba.fieldops.core.util.formatQty(allocation.remainingQty),
        )
    }
