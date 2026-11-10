package com.cortoba.fieldops.ui.deliveries

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.CustomerDeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmRequest
import com.cortoba.fieldops.core.network.dto.DeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryItemRequest
import com.cortoba.fieldops.core.network.dto.DeliveryListResponse
import com.cortoba.fieldops.core.util.formatQty
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
    /** Assignment the entries were seeded from — makes seeding idempotent. */
    val seededFor: Int? = null,
    /** Customer key the entries were seeded from (workbench mode). */
    val seededForCustomer: String? = null,
)

/**
 * One editable delivery row, keyed by the customer PO ITEM id.
 *
 * `availableQty` is the ceiling the server enforces: the quantity actually
 * received and accepted from the supplier, minus what was already delivered and
 * rejected. The UI clamps to it, and the server rejects anything above it.
 */
data class DeliveryEntry(
    val customerPoItemId: Int,
    val customerPoId: Int,
    val assignmentId: Int?,
    val poNo: String,
    val displayName: String,
    val orderedQty: Double,
    val availableQty: Double,
    val alreadyDeliveredQty: Double,
    val alreadyRejectedQty: Double = 0.0,
    val deliveredQty: String,
    val rejectedQty: String = "",
    val rejectionReason: String = "",
) {
    /** Selected state of the line: derived from the typed quantities. */
    val mode: DeliveryLineMode
        get() {
            val delivered = deliveredQty.toDoubleOrNull() ?: 0.0
            return when {
                delivered <= 1e-6 -> DeliveryLineMode.REJECT
                delivered >= availableQty - 1e-6 -> DeliveryLineMode.FULL
                else -> DeliveryLineMode.PARTIAL
            }
        }
}

/** How a single PO line is being settled. */
enum class DeliveryLineMode { FULL, PARTIAL, REJECT }

/** Common rejection reasons, plus «أخرى» for a free-text reason. */
val DELIVERY_REJECTION_REASONS = listOf(
    "تالف",
    "خطأ في الصنف",
    "كمية أقل",
    "متأخر عن الموعد",
    "مواصفات غير مطابقة",
    "أخرى",
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
    fun loadCustomerDetail(key: String, forceReseed: Boolean = false) {
        if (forceReseed) _form.update { it.copy(seededForCustomer = null) }
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
                seedCustomerForm(key, result.value)
            } catch (e: ApiException) {
                _customerDetail.update { it.copy(loading = false, error = e.userMessage) }
            }
        }
    }

    // ── Customer workbench actions ─────────────────────────────────────────

    /**
     * «كلي» on one PO line: deliver its whole remaining quantity — and send it
     * to the server at once. There is no separate confirm step; the tap is the
     * confirmation.
     */
    fun deliverLineFull(customerKey: String?, customerPoItemId: Int) {
        val entry = _form.value.entries.firstOrNull { it.customerPoItemId == customerPoItemId } ?: return
        sendLines(
            customerKey,
            listOf(entry.copy(deliveredQty = formatQty(entry.availableQty), rejectionReason = "")),
        )
    }

    /**
     * «رفض» on one PO line: record nothing delivered and the whole available
     * quantity rejected, with the mandatory reason, at once.
     */
    fun rejectLine(customerKey: String?, customerPoItemId: Int) {
        val entry = _form.value.entries.firstOrNull { it.customerPoItemId == customerPoItemId } ?: return
        val reason = entry.rejectionReason.trim()
        if (reason.isBlank()) {
            _form.update { it.copy(error = "اختر سبب رفض الصنف أولاً") }
            return
        }
        sendLines(customerKey, listOf(entry.copy(deliveredQty = "0", rejectionReason = reason)))
    }

    /** «تنفيذ» on a partial line: send the quantity the rep typed. */
    fun deliverLinePartial(customerKey: String?, customerPoItemId: Int) {
        val entry = _form.value.entries.firstOrNull { it.customerPoItemId == customerPoItemId } ?: return
        val delivered = entry.deliveredQty.toDoubleOrNull()
        if (delivered == null || delivered < 0) {
            _form.update { it.copy(error = "أدخل كمية صحيحة") }
            return
        }
        if (delivered > entry.availableQty + 1e-6) {
            _form.update {
                it.copy(
                    error = "الكمية المسلّمة أكبر من المتاح (${entry.displayName}). " +
                        "المتاح: ${formatQty(entry.availableQty)}",
                )
            }
            return
        }
        if (delivered <= 1e-6) {
            _form.update { it.copy(error = "أدخل الكمية المسلّمة أو استخدم «رفض»") }
            return
        }
        sendLines(customerKey, listOf(entry))
    }

    /** «تسليم كلي» on a whole PO: deliver every line of that order at once. */
    fun deliverPoFull(customerKey: String?, customerPoId: Int) {
        val lines = _form.value.entries.filter { it.customerPoId == customerPoId }
        if (lines.isEmpty()) return
        sendLines(customerKey, lines.map { it.copy(deliveredQty = formatQty(it.availableQty), rejectionReason = "") })
    }

    /** «رفض كلي» on a whole PO: reject every line with the chosen reason. */
    fun rejectPo(customerKey: String?, customerPoId: Int, reason: String) {
        val lines = _form.value.entries.filter { it.customerPoId == customerPoId }
        if (lines.isEmpty()) return
        if (reason.isBlank()) {
            _form.update { it.copy(error = "اختر سبب الرفض أولاً") }
            return
        }
        sendLines(customerKey, lines.map { it.copy(deliveredQty = "0", rejectionReason = reason) })
    }

    /** Set the rejection reason on one line (free text from «أخرى»). */
    fun setLineReason(customerPoItemId: Int, reason: String) {
        _form.update { state ->
            state.copy(
                entries = state.entries.map {
                    if (it.customerPoItemId == customerPoItemId) it.copy(rejectionReason = reason) else it
                },
            )
        }
    }

    /**
     * Send the given lines through the assignment that owns each purchase order
     * (a customer can have several POs, each with its own task), then reload the
     * customer so a settled order disappears and the rest stay.
     */
    private fun sendLines(customerKey: String?, lines: List<DeliveryEntry>) {
        val byAssignment = lines.filter { it.assignmentId != null }.groupBy { it.assignmentId!! }
        if (byAssignment.isEmpty()) {
            _form.update { it.copy(error = "لا توجد مهمة تسليم مرتبطة بهذا الأمر") }
            return
        }
        // Apply the chosen quantities to the form so the UI shows what is sent.
        _form.update { state ->
            val byId = lines.associateBy { it.customerPoItemId }
            state.copy(
                entries = state.entries.map { byId[it.customerPoItemId] ?: it },
                submitting = true,
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                var queuedOffline = false
                for ((assignmentId, group) in byAssignment) {
                    val request = DeliveryConfirmRequest(
                        items = group.map { entry ->
                            val delivered = entry.deliveredQty.toDoubleOrNull() ?: 0.0
                            // A line with nothing delivered is a full rejection of
                            // its remaining quantity, recorded with the reason so
                            // the line settles and the order can close.
                            val rejected = if (delivered <= 1e-6) entry.availableQty else 0.0
                            DeliveryItemRequest(
                                customerPoItemId = entry.customerPoItemId,
                                deliveredQty = delivered,
                                rejectedByCustomerQty = rejected,
                                rejectionReason = entry.rejectionReason.takeIf { it.isNotBlank() },
                                notes = null,
                            )
                        },
                        clientUuid = java.util.UUID.randomUUID().toString(),
                        gps = com.cortoba.fieldops.core.location.LocationProvider.lastKnown(),
                    )
                    val outcome = repository.confirmDelivery(assignmentId, request)
                    if (outcome.fromCache) queuedOffline = true
                }
                _form.update { it.copy(submitting = false, error = null) }
                if (customerKey != null) loadCustomerDetail(customerKey, forceReseed = true)
                if (queuedOffline) {
                    _form.update { it.copy(error = "لا يوجد اتصال — تم الحفظ وسيُرسل تلقائياً") }
                }
            } catch (e: ApiException) {
                _form.update { it.copy(submitting = false, error = e.userMessage) }
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
                        customerPoId = detail.customerPo?.id ?: 0,
                        assignmentId = detail.assignmentId,
                        poNo = detail.customerPo?.customerPoNo ?: "",
                        displayName = item.description,
                        orderedQty = item.orderedQty,
                        availableQty = item.availableQty,
                        alreadyDeliveredQty = item.deliveredQty,
                        alreadyRejectedQty = item.rejectedByCustomerQty,
                        deliveredQty = com.cortoba.fieldops.core.util.formatQty(item.availableQty),
                    )
                },
                error = null,
                seededFor = assignmentId,
            )
        }
    }

    /**
     * Seed the workbench form from the whole customer, one entry per PO line that
     * still has quantity to settle. Called from [loadCustomerDetail] so the
     * rep can settle every order of the customer from one screen.
     *
     * Idempotent per customer key: re-opening the same customer keeps whatever
     * the rep has already typed.
     */
    private fun seedCustomerForm(key: String, detail: CustomerDeliveryDetailResponse) {
        _form.update { current ->
            if (current.seededForCustomer == key && current.entries.isNotEmpty()) return@update current
            val entries = detail.purchaseOrders.flatMap { po ->
                po.items
                    .filter { it.availableQty > 0 }
                    .map { item ->
                        DeliveryEntry(
                            customerPoItemId = item.customerPoItemId,
                            customerPoId = po.customerPoId,
                            assignmentId = po.assignmentId,
                            poNo = po.customerPoNo,
                            displayName = item.description,
                            orderedQty = item.orderedQty,
                            availableQty = item.availableQty,
                            alreadyDeliveredQty = item.deliveredQty,
                            alreadyRejectedQty = item.rejectedByCustomerQty,
                            deliveredQty = com.cortoba.fieldops.core.util.formatQty(item.availableQty),
                        )
                    }
            }
            current.copy(
                entries = entries,
                error = null,
                seededFor = null,
                seededForCustomer = key,
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
