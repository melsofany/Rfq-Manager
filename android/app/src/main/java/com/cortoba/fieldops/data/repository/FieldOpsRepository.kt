package com.cortoba.fieldops.data.repository

import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.CortobaApi
import com.cortoba.fieldops.core.network.apiCall
import com.cortoba.fieldops.core.network.apiCallUnit
import com.cortoba.fieldops.core.network.dto.ChangePasswordRequest
import com.cortoba.fieldops.core.network.dto.DashboardResponse
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmRequest
import com.cortoba.fieldops.core.network.dto.HistoryResponse
import com.cortoba.fieldops.core.network.dto.LoginRequest
import com.cortoba.fieldops.core.network.dto.LoginResponse
import com.cortoba.fieldops.core.network.dto.NotificationDto
import com.cortoba.fieldops.core.network.dto.PickupDetailResponse
import com.cortoba.fieldops.core.network.dto.PickupListResponse
import com.cortoba.fieldops.core.network.dto.ProfileResponse
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmRequest
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmResponse
import com.cortoba.fieldops.core.network.dto.DeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryListResponse
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmResponse
import com.cortoba.fieldops.core.session.SessionStore
import com.cortoba.fieldops.data.local.CachedDeliveryDetailEntity
import com.cortoba.fieldops.data.local.CachedDeliveryTaskEntity
import com.cortoba.fieldops.data.local.CachedNotificationEntity
import com.cortoba.fieldops.data.local.CachedPickupDetailEntity
import com.cortoba.fieldops.data.local.CachedPickupTaskEntity
import com.cortoba.fieldops.data.local.FieldOpsDao
import com.cortoba.fieldops.data.local.PendingOperationEntity
import com.cortoba.fieldops.data.local.SyncStatus
import com.cortoba.fieldops.data.sync.SyncEngine
import com.cortoba.fieldops.data.sync.SyncScheduler
import com.google.gson.Gson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A payload together with where it came from. `fromCache = true` is what lets
 * the UI show «محفوظ محلياً» instead of pretending the data is live.
 */
data class Cached<T>(val value: T, val fromCache: Boolean, val cachedAt: Long? = null)

/**
 * The single data entry point for the app.
 *
 * Read path:  try the network → on success cache it; on a network failure fall
 *             back to the cache and flag it as stale.
 * Write path: try the network → on a network failure queue it in the outbox and
 *             report SAVED_LOCALLY. A server 4xx is never queued: the backend
 *             rejected the data, and silently retrying would hide the reason.
 */
@Singleton
class FieldOpsRepository @Inject constructor(
    private val api: CortobaApi,
    private val dao: FieldOpsDao,
    private val gson: Gson,
    private val sessionStore: SessionStore,
    private val scheduler: SyncScheduler,
) {

    // ── Auth ──────────────────────────────────────────────────────────────

    suspend fun login(employeeNo: String, password: String): LoginResponse {
        val response = apiCall { api.login(LoginRequest(employeeNo.trim(), password)) }
        sessionStore.saveSession(response.token, response.employee.fullName, response.employee.employeeNo)
        return response
    }

    suspend fun logout() {
        // Best-effort server revoke; the local session is cleared either way so
        // the device cannot keep operating on a token we believe is gone.
        runCatching { apiCallUnit { api.logout() } }
        dao.clearPending()
        dao.clearNotifications()
        dao.clearPickupTasks()
        dao.clearDeliveryTasks()
        sessionStore.clear()
    }

    suspend fun changePassword(current: String, new: String) {
        apiCallUnit { api.changePassword(ChangePasswordRequest(current, new)) }
        // The server revokes every session on a password change.
        sessionStore.clear()
    }

    suspend fun profile(): ProfileResponse = apiCall { api.profile() }

    suspend fun history(): HistoryResponse = apiCall { api.history() }

    // ── Dashboard ─────────────────────────────────────────────────────────

    suspend fun dashboard(): DashboardResponse = apiCall { api.dashboard() }

    // ── Pickups ───────────────────────────────────────────────────────────

    fun observeCachedPickupTasks(): Flow<List<PickupListResponse>> =
        dao.observePickupTasks().map { rows ->
            rows.mapNotNull { row -> runCatching { gson.fromJson(row.payloadJson, PickupListResponse::class.java) }.getOrNull() }
        }

    suspend fun pickups(): Cached<PickupListResponse> {
        return try {
            val fresh = apiCall { api.pickups() }
            dao.cachePickupTasks(
                fresh.tasks.map { task ->
                    CachedPickupTaskEntity(
                        poId = task.poId,
                        assignmentId = task.assignmentId,
                        payloadJson = gson.toJson(task),
                        cachedAt = System.currentTimeMillis(),
                    )
                },
            )
            // The consolidated groups are what the list renders, so cache the
            // whole response on each task row and rebuild it from the first row.
            dao.cachePickupDetail(
                CachedPickupDetailEntity(WHOLE_LIST_KEY, gson.toJson(fresh), System.currentTimeMillis()),
            )
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized) throw e
            val cached = dao.pickupDetail(WHOLE_LIST_KEY)
                ?: return Cached(PickupListResponse(), fromCache = true)
            Cached(gson.fromJson(cached.payloadJson, PickupListResponse::class.java), true, cached.cachedAt)
        }
    }

    suspend fun pickupDetail(assignmentId: Int): Cached<PickupDetailResponse> {
        return try {
            val fresh = apiCall { api.pickup(assignmentId) }
            dao.cachePickupDetail(
                CachedPickupDetailEntity(assignmentId, gson.toJson(fresh), System.currentTimeMillis()),
            )
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized) throw e
            val cached = dao.pickupDetail(assignmentId)
                ?: throw ApiException(0, "لا يوجد اتصال، ولا توجد نسخة محفوظة لهذه المهمة")
            Cached(gson.fromJson(cached.payloadJson, PickupDetailResponse::class.java), true, cached.cachedAt)
        }
    }

    /** Record a receipt. Offline saves are queued, never lost. */
    suspend fun confirmReceipt(
        assignmentId: Int,
        request: ReceiptConfirmRequest,
    ): Cached<ReceiptConfirmResponse> {
        return try {
            val fresh = apiCall { api.confirmReceipt(assignmentId, request) }
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized || !e.isNetwork) throw e
            enqueue(SyncEngine.TYPE_RECEIPT, assignmentId, request)
            Cached(ReceiptConfirmResponse(success = false, duplicate = false), fromCache = true)
        }
    }

    // ── Deliveries ────────────────────────────────────────────────────────

    suspend fun deliveries(): Cached<DeliveryListResponse> {
        return try {
            val fresh = apiCall { api.deliveries() }
            dao.cacheDeliveryTasks(
                fresh.tasks.map { task ->
                    CachedDeliveryTaskEntity(task.assignmentId, gson.toJson(task), System.currentTimeMillis())
                },
            )
            dao.cacheDeliveryDetail(
                CachedDeliveryDetailEntity(WHOLE_LIST_KEY, gson.toJson(fresh), System.currentTimeMillis()),
            )
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized) throw e
            val cached = dao.deliveryDetail(WHOLE_LIST_KEY)
                ?: return Cached(DeliveryListResponse(), fromCache = true)
            Cached(gson.fromJson(cached.payloadJson, DeliveryListResponse::class.java), true, cached.cachedAt)
        }
    }

    suspend fun deliveryDetail(assignmentId: Int): Cached<DeliveryDetailResponse> {
        return try {
            val fresh = apiCall { api.delivery(assignmentId) }
            dao.cacheDeliveryDetail(
                CachedDeliveryDetailEntity(assignmentId, gson.toJson(fresh), System.currentTimeMillis()),
            )
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized) throw e
            val cached = dao.deliveryDetail(assignmentId)
                ?: throw ApiException(0, "لا يوجد اتصال، ولا توجد نسخة محفوظة لهذه المهمة")
            Cached(gson.fromJson(cached.payloadJson, DeliveryDetailResponse::class.java), true, cached.cachedAt)
        }
    }

    suspend fun confirmDelivery(
        assignmentId: Int,
        request: DeliveryConfirmRequest,
    ): Cached<DeliveryConfirmResponse> {
        return try {
            val fresh = apiCall { api.confirmDelivery(assignmentId, request) }
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized || !e.isNetwork) throw e
            enqueue(SyncEngine.TYPE_DELIVERY, assignmentId, request)
            Cached(DeliveryConfirmResponse(success = false), fromCache = true)
        }
    }

    // ── Notifications ─────────────────────────────────────────────────────

    fun observeCachedNotifications(): Flow<List<NotificationDto>> =
        dao.observeNotifications().map { rows ->
            rows.mapNotNull { runCatching { gson.fromJson(it.payloadJson, NotificationDto::class.java) }.getOrNull() }
        }

    suspend fun notifications(): Cached<List<NotificationDto>> {
        return try {
            val fresh = apiCall { api.notifications() }
            dao.cacheNotifications(
                fresh.map { CachedNotificationEntity(it.id, gson.toJson(it), System.currentTimeMillis()) },
            )
            Cached(fresh, fromCache = false)
        } catch (e: ApiException) {
            if (e.isUnauthorized) throw e
            val cached = dao.notifications().mapNotNull {
                runCatching { gson.fromJson(it.payloadJson, NotificationDto::class.java) }.getOrNull()
            }
            Cached(cached, fromCache = true)
        }
    }

    suspend fun markNotificationRead(id: Int) = apiCallUnit { api.markNotificationRead(id) }

    suspend fun markAllNotificationsRead() = apiCallUnit { api.markAllNotificationsRead() }

    // ── Outbox ────────────────────────────────────────────────────────────

    private suspend fun enqueue(type: String, assignmentId: Int, payload: Any) {
        // A fresh UUID is the idempotency key. It is generated ONCE here and
        // reused by every retry, which is what makes the replay safe.
        val clientUuid = UUID.randomUUID().toString()
        val stamped = when (payload) {
            is ReceiptConfirmRequest -> gson.toJson(payload.copy(clientUuid = clientUuid))
            is DeliveryConfirmRequest -> gson.toJson(payload.copy(clientUuid = clientUuid))
            else -> gson.toJson(payload)
        }
        dao.enqueue(
            PendingOperationEntity(
                clientUuid = clientUuid,
                type = type,
                assignmentId = assignmentId,
                payloadJson = stamped,
                status = SyncStatus.SAVED_LOCALLY.name,
            ),
        )
        // Ask WorkManager to try immediately if there is connectivity.
        scheduler.syncNow()
    }

    fun observePending(): Flow<List<PendingOperationEntity>> = dao.observePending()

    fun observePendingCount(): Flow<Int> = dao.observePendingCount()

    suspend fun retrySync() {
        scheduler.syncNow()
    }

    private fun ApiException.isNetwork(): Boolean = statusCode == 0

    private companion object {
        /**
         * Sentinel row id for "the whole list response". The list endpoints
         * return aggregated groups the per-task rows cannot rebuild, so the
         * full payload is cached once and read back as one object.
         */
        const val WHOLE_LIST_KEY = -1
    }
}
