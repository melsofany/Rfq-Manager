package com.cortoba.fieldops.ui.deliveries

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.CustomerDeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmRequest
import com.cortoba.fieldops.core.network.dto.DeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryItemRequest
import com.cortoba.fieldops.core.network.dto.DeliveryListResponse
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DeliveryListUiState(
    val loading: Boolean = true,
    val data: DeliveryListResponse? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
    val cachedAt: Long? = null,
)

data class DeliveryDetailUiState(
    val loading: Boolean = true,
    val data: DeliveryDetailResponse? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
    val cachedAt: Long? = null,
)

data class CustomerDeliveryDetailUiState(
    val loading: Boolean = true,
    val data: CustomerDeliveryDetailResponse? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
    val cachedAt: Long? = null,
)

data class DeliveryFormState(
    val entries: List<DeliveryEntry> = emptyList(),
    val notes: String = "",
    val submitting: Boolean = false,
    val error: String? = null,
    val result: DeliverySubmitResult? = null,
    /** Assignment the entries were seeded from — makes seeding idempotent. */
    val seededFor: Int? = null,
)

data class DeliverySubmitResult(
    val queuedOffline: Boolean,
    val deliveredQty: Double,
    val remainingQty: Double,
)

/**
 * One editable delivery row, keyed by the customer PO ITEM id.
 *
 * `availableQty` is the ceiling the server enforces: the quantity actually
 * received and accepted from the supplier, minus what was already delivered.
 * The UI clamps to it, and the server rejects anything above it.
 */
data class DeliveryEntry(
    val customerPoItemId: Int,
    val displayName: String,
    val orderedQty: Double,
    val availableQty: Double,
    val alreadyDeliveredQty: Double,
    val deliveredQty: String,
    val rejectedQty: String = "",
    val rejectionReason: String = "",
)

@HiltViewModel
class DeliveryViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _list = MutableStateFlow(DeliveryListUiState())
    val list: StateFlow<DeliveryListUiState> = _list.asStateFlow()

    private val _detail = MutableStateFlow(DeliveryDetailUiState())
    val detail: StateFlow<DeliveryDetailUiState> = _detail.asStateFlow()

    private val _customerDetail = MutableStateFlow(CustomerDeliveryDetailUiState())
    val customerDetail: StateFlow<CustomerDeliveryDetailUiState> = _customerDetail.asStateFlow()

    private val _form = MutableStateFlow(DeliveryFormState())
    val form: StateFlow<DeliveryFormState> = _form.asStateFlow()

    fun loadList() {
        _list.update { it.copy(loading = it.data == null, error = null) }
        viewModelScope.launch {
            try {
                val result = repository.deliveries()
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
                val result = repository.deliveryDetail(assignmentId)
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
     * Load one customer with all of their purchase orders. The list screen shows
     * a square per customer, so this is the drill-down before the per-PO detail.
     * `key` is `id:<customerId>` or `name:<name>`.
     */
    fun loadCustomerDetail(key: String) {
        _customerDetail.update { it.copy(loading = it.data == null, error = null) }
        viewModelScope.launch {
            try {
                val result = repository.customerDeliveryDetail(key)
                _customerDetail.update {
                    it.copy(
                        loading = false,
                        data = result.value,
                        fromCache = result.fromCache,
                        cachedAt = result.cachedAt,
                    )
                }
            } catch (e: ApiException) {
                _customerDetail.update { it.copy(loading = false, error = e.userMessage) }
            }
        }
    }

    /**
     * Seed the delivery form from the loaded task.
     *
     * Called from [loadDetail] once the task has arrived, never from a sibling
     * call in the screen: `loadDetail` is asynchronous, so a separate
     * `prepareForm()` fired alongside it reads `_detail` while it is still empty
     * and leaves the form with zero rows — the rep then sees no items to deliver.
     */
    private fun seedForm(assignmentId: Int, detail: DeliveryDetailResponse) {
        _form.update { current ->
            // Re-seeding would discard quantities the rep has already typed.
            if (current.seededFor == assignmentId && current.entries.isNotEmpty()) return@update current
            current.copy(
                entries = detail.items.map { item ->
                    DeliveryEntry(
                        customerPoItemId = item.customerPoItemId,
                        displayName = item.description,
                        orderedQty = item.orderedQty,
                        availableQty = item.availableQty,
                        alreadyDeliveredQty = item.deliveredQty,
                        deliveredQty = com.cortoba.fieldops.core.util.formatQty(item.availableQty),
                    )
                },
                error = null,
                result = null,
                seededFor = assignmentId,
            )
        }
    }

    fun onDeliveredQtyChange(customerPoItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) {
                        it.copy(deliveredQty = sanitizeNumber(value))
                    } else {
                        it
                    }
                },
                error = null,
            )
        }
    }

    fun onRejectedQtyChange(customerPoItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) {
                        it.copy(rejectedQty = sanitizeNumber(value))
                    } else {
                        it
                    }
                },
                error = null,
            )
        }
    }

    fun onRejectionReasonChange(customerPoItemId: Int, value: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) it.copy(rejectionReason = value) else it
                },
            )
        }
    }

    fun onNotesChange(value: String) = _form.update { it.copy(notes = value) }

    fun markFullQuantity(customerPoItemId: Int) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) {
                        it.copy(
                            deliveredQty = com.cortoba.fieldops.core.util.formatQty(it.availableQty),
                            rejectedQty = "",
                        )
                    } else {
                        it
                    }
                },
            )
        }
    }

    fun markRejected(customerPoItemId: Int) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) {
                        it.copy(deliveredQty = "0", rejectedQty = "") 
                    } else {
                        it
                    }
                },
            )
        }
    }

    fun deliverySummary(): DeliverySummary {
        val entries = _form.value.entries
        return DeliverySummary(
            distinctItems = entries.size,
            totalOrdered = entries.sumOf { it.orderedQty },
            totalAvailable = entries.sumOf { it.availableQty },
            totalDelivered = entries.sumOf { it.deliveredQty.toDoubleOrNull() ?: 0.0 },
            totalRejected = entries.sumOf { it.rejectedQty.toDoubleOrNull() ?: 0.0 },
        )
    }

    fun submit(assignmentId: Int) {
        val state = _form.value
        val entries = state.entries
        if (entries.isEmpty()) {
            _form.update { it.copy(error = "لا توجد أصناف للتسليم") }
            return
        }

        for (entry in entries) {
            val delivered = entry.deliveredQty.toDoubleOrNull()
            if (delivered == null || delivered < 0) {
                _form.update { it.copy(error = "أدخل كمية صحيحة لكل صنف") }
                return
            }
            // The UI must never let a rep promise more than was received and
            // accepted from the supplier. The server enforces this too; failing
            // here gives a clearer message and saves a round-trip.
            if (delivered > entry.availableQty) {
                _form.update {
                    it.copy(
                        error = "الكمية المسلّمة أكبر من المتاح (${entry.displayName}). " +
                            "المتاح: ${com.cortoba.fieldops.core.util.formatQty(entry.availableQty)}",
                    )
                }
                return
            }
            val rejected = entry.rejectedQty.toDoubleOrNull() ?: 0.0
            if (rejected < 0 || rejected > entry.availableQty) {
                _form.update { it.copy(error = "الكمية المرفوضة غير صحيحة") }
                return
            }
        }

        val summary = deliverySummary()
        _form.update { it.copy(submitting = true, error = null) }

        viewModelScope.launch {
            try {
                val request = DeliveryConfirmRequest(
                    items = entries.map { entry ->
                        DeliveryItemRequest(
                            customerPoItemId = entry.customerPoItemId,
                            deliveredQty = entry.deliveredQty.toDoubleOrNull() ?: 0.0,
                            rejectedByCustomerQty = entry.rejectedQty.toDoubleOrNull() ?: 0.0,
                            rejectionReason = entry.rejectionReason.takeIf { it.isNotBlank() },
                            notes = null,
                        )
                    },
                    clientUuid = java.util.UUID.randomUUID().toString(),
                    gps = com.cortoba.fieldops.core.location.LocationProvider.lastKnown(),
                )
                val outcome = repository.confirmDelivery(assignmentId, request)
                _form.update {
                    it.copy(
                        submitting = false,
                        result = DeliverySubmitResult(
                            queuedOffline = outcome.fromCache,
                            deliveredQty = summary.totalDelivered,
                            remainingQty = (summary.totalAvailable - summary.totalDelivered)
                                .coerceAtLeast(0.0),
                        ),
                    )
                }
            } catch (e: ApiException) {
                _form.update { it.copy(submitting = false, error = e.userMessage) }
            }
        }
    }

    private fun sanitizeNumber(raw: String): String {
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

data class DeliverySummary(
    val distinctItems: Int = 0,
    val totalOrdered: Double = 0.0,
    val totalAvailable: Double = 0.0,
    val totalDelivered: Double = 0.0,
    val totalRejected: Double = 0.0,
)
