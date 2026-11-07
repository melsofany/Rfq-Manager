package com.cortoba.fieldops.core.network.dto

import com.google.gson.annotations.SerializedName

/**
 * The wire contract with the `/api/mobile` endpoints. Field names mirror the
 * server payloads exactly; Gson maps them 1:1 so a server rename fails loudly at
 * the boundary rather than silently producing empty screens.
 */

data class LoginRequest(
    val employeeNo: String,
    val password: String,
    val fcmToken: String? = null,
)

data class LoginResponse(
    val token: String,
    val expiresAt: String,
    val employee: EmployeeDto,
    val isFieldRepresentative: Boolean = false,
)

data class EmployeeDto(
    val hrEmployeeId: Int,
    val employeeNo: String,
    val fullName: String,
    val fullNameEn: String? = null,
    val jobTitle: String? = null,
    val department: String? = null,
    val phone: String? = null,
)

data class ChangePasswordRequest(
    val currentPassword: String,
    val newPassword: String,
)

data class DashboardResponse(
    val employee: EmployeeDto,
    val isFieldRepresentative: Boolean = false,
    val today: String? = null,
    val indicators: DashboardIndicators,
    val modules: DashboardModules,
)

data class DashboardIndicators(
    val receiptNew: Int = 0,
    val receiptInProgress: Int = 0,
    val receiptCompleted: Int = 0,
    val deliveryNew: Int = 0,
    val deliveryInProgress: Int = 0,
    val deliveryCompleted: Int = 0,
    val pendingReceiptItems: Int = 0,
    val pendingDeliveryItems: Int = 0,
    val unreadNotifications: Int = 0,
)

data class DashboardModules(
    val pickups: Boolean = true,
    val deliveries: Boolean = true,
    val financialCustody: CustodyModule = CustodyModule(),
)

data class CustodyModule(
    val enabled: Boolean = false,
    val label: String = "قريباً",
)

// ── Pickups ────────────────────────────────────────────────────────────────

data class PickupListResponse(
    val tasks: List<PickupTask> = emptyList(),
    val consolidatedItems: List<ConsolidatedItem> = emptyList(),
    val summary: PickupSummary = PickupSummary(),
)

data class PickupSummary(
    val taskCount: Int = 0,
    val distinctItems: Int = 0,
    val totalRemainingQty: Double = 0.0,
)

data class SupplierDto(
    val id: Int,
    val name: String,
    val phone: String? = null,
    val address: String? = null,
    val contactPerson: String? = null,
)

data class PickupTask(
    val assignmentId: Int? = null,
    val poId: Int,
    val poNo: String,
    val status: String,
    /**
     * Settlement state for the supplier card — "unpaid" | "partial" | "paid".
     * No amounts: the rep only needs to know whether the supplier was paid.
     */
    val paymentStatus: String = "unpaid",
    val poDate: String? = null,
    val notes: String? = null,
    val supplier: SupplierDto? = null,
    val distinctItemCount: Int = 0,
    val totalRequiredQty: Double = 0.0,
)

data class ConsolidatedItem(
    val groupKey: String,
    val matchBasis: String,
    val displayName: String,
    val partNo: String? = null,
    val itemId: String? = null,
    val lineItem: String? = null,
    val uom: String? = null,
    val totalRequiredQty: Double = 0.0,
    val totalAcceptedQty: Double = 0.0,
    val totalRemainingQty: Double = 0.0,
    val allocations: List<PickupAllocation> = emptyList(),
    val customerPoNos: List<String> = emptyList(),
)

/** One original PO line inside a consolidated group — traceability preserved. */
data class PickupAllocation(
    val poItemId: Int,
    val poId: Int,
    val poNo: String,
    val supplierId: Int? = null,
    val qty: Double = 0.0,
    val acceptedQty: Double = 0.0,
    val remainingQty: Double = 0.0,
    val lineStatus: String = "",
    val customerPoNos: List<String> = emptyList(),
)

data class PickupDetailResponse(
    val assignmentId: Int,
    val status: String,
    val executorRole: String = "owner",
    val po: PoRef? = null,
    val supplier: SupplierDto? = null,
    val paymentStatus: String = "unpaid",
    val items: List<ConsolidatedItem> = emptyList(),
    val responsibleEmployeeId: Int? = null,
    val representativeName: String? = null,
)

data class PoRef(
    val id: Int,
    val poNo: String,
    val notes: String? = null,
    val poDate: String? = null,
)

data class GpsPoint(
    val lat: Double? = null,
    val lng: Double? = null,
)

data class ReceiptItemRequest(
    val poItemId: Int,
    val receivedQty: Double,
    val acceptedQty: Double,
    val rejectedQty: Double = 0.0,
    val rejectionReason: String? = null,
    val notes: String? = null,
)

data class ReceiptConfirmRequest(
    val items: List<ReceiptItemRequest>,
    val clientUuid: String,
    val gps: GpsPoint? = null,
)

data class ReceiptConfirmResponse(
    val success: Boolean,
    val receiptIds: List<Int> = emptyList(),
    val duplicate: Boolean = false,
    /** Server-authoritative task status after this receipt (partial vs closed). */
    val assignmentStatus: String? = null,
    val deliverableNow: List<DeliverableQty> = emptyList(),
)

data class DeliverableQty(
    val poItemId: Int,
    val acceptedQty: Double,
)

// ── Deliveries ─────────────────────────────────────────────────────────────

data class DeliveryListResponse(
    val tasks: List<DeliveryTask> = emptyList(),
    val summary: DeliverySummary = DeliverySummary(),
)

data class DeliverySummary(
    val taskCount: Int = 0,
    val distinctItems: Int = 0,
    val availableQty: Double = 0.0,
)

data class DeliveryTask(
    val assignmentId: Int,
    val customerPoId: Int,
    val customerPoNo: String,
    val customerName: String? = null,
    val poDate: String? = null,
    val notes: String? = null,
    val status: String = "",
    val distinctItemCount: Int = 0,
    val availableQty: Double = 0.0,
)

data class CustomerDto(
    val id: Int? = null,
    val name: String? = null,
    val phone: String? = null,
    val address: String? = null,
    val contactPerson: String? = null,
)

data class DeliveryDetailResponse(
    val assignmentId: Int,
    val status: String,
    val executorRole: String = "owner",
    val customerPo: CustomerPoRef? = null,
    val customer: CustomerDto? = null,
    val items: List<DeliveryItem> = emptyList(),
    val responsibleEmployeeId: Int? = null,
    val representativeName: String? = null,
)

data class CustomerPoRef(
    val id: Int,
    val customerPoNo: String,
    val customerName: String? = null,
    val poDate: String? = null,
    val notes: String? = null,
)

data class DeliveryItem(
    val customerPoItemId: Int,
    val partNo: String? = null,
    val lineItem: String? = null,
    val description: String,
    val uom: String? = null,
    val orderedQty: Double = 0.0,
    val acceptedFromSupplierQty: Double? = null,
    val deliveredQty: Double = 0.0,
    val availableQty: Double = 0.0,
    val deliveryStatus: String = "",
)

data class DeliveryItemRequest(
    val customerPoItemId: Int,
    val deliveredQty: Double,
    val rejectedByCustomerQty: Double = 0.0,
    val rejectionReason: String? = null,
    val notes: String? = null,
)

data class DeliveryConfirmRequest(
    val items: List<DeliveryItemRequest>,
    val clientUuid: String,
    val gps: GpsPoint? = null,
)

data class DeliveryConfirmResponse(
    val success: Boolean,
    val deliveryIds: List<Int> = emptyList(),
)

// ── Notifications / sync ───────────────────────────────────────────────────

data class NotificationDto(
    val id: Int,
    val kind: String,
    val title: String,
    val body: String? = null,
    val entityType: String? = null,
    val entityId: Int? = null,
    val read: Boolean = false,
    val createdAt: String,
)

data class SyncOperationRequest(
    val clientUuid: String,
    val type: String,
    val assignmentId: Int,
    val payload: Any? = null,
)

data class SyncRequest(
    val operations: List<SyncOperationRequest> = emptyList(),
    val since: String? = null,
)

data class SyncResponse(
    val results: List<SyncResult> = emptyList(),
    val serverTime: String,
    val assignments: List<SyncAssignment> = emptyList(),
    val notifications: List<NotificationDto> = emptyList(),
)

data class SyncResult(
    val clientUuid: String,
    val status: String,
    val message: String? = null,
    val resultId: Int? = null,
)

data class SyncAssignment(
    val assignmentId: Int,
    val kind: String,
    val status: String,
    val updatedAt: String,
)

data class ProfileResponse(
    val hrEmployeeId: Int,
    val employeeNo: String,
    val fullName: String,
    val fullNameEn: String? = null,
    val jobTitle: String? = null,
    val department: String? = null,
    val phone: String? = null,
    val isFieldRepresentative: Boolean = false,
    val fieldAssignments: List<FieldAssignmentDto> = emptyList(),
)

data class FieldAssignmentDto(
    val id: Int,
    val status: String,
    val assignedAt: String,
    val revokedAt: String? = null,
    val assignmentType: String? = null,
)

data class HistoryResponse(
    val receipts: List<HistoryReceipt> = emptyList(),
    val deliveries: List<HistoryDelivery> = emptyList(),
)

data class HistoryReceipt(
    val id: Int,
    val poNo: String? = null,
    val receivedQty: String? = null,
    val acceptedQty: String? = null,
    val rejectedQty: String? = null,
    @SerializedName("status") val status: String? = null,
    val at: String,
    val description: String? = null,
)

data class HistoryDelivery(
    val id: Int,
    val customerPoNo: String? = null,
    val deliveredQty: String? = null,
    val status: String? = null,
    val at: String,
    val description: String? = null,
)

/** Latest published app version, returned by GET /api/mobile/version. */
data class AppVersionDto(
    val versionCode: Int = 0,
    val versionName: String = "",
    val downloadUrl: String? = null,
)

/** Server error body: `{ "error": "..." }`. */
data class ApiError(val error: String? = null)
