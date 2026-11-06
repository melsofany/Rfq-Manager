package com.cortoba.fieldops.data.sync

import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.CortobaApi
import com.cortoba.fieldops.core.network.apiCall
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmRequest
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmRequest
import com.cortoba.fieldops.core.network.dto.SyncRequest
import com.cortoba.fieldops.data.local.FieldOpsDao
import com.cortoba.fieldops.data.local.PendingOperationEntity
import com.cortoba.fieldops.data.local.SyncStatus
import com.google.gson.Gson
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Replays the offline outbox.
 *
 * Two design points that matter:
 *
 *  • The queued payload is replayed through the SAME confirm endpoint the online
 *    path uses, with the SAME client UUID. The server's unique
 *    (employee, clientUuid) constraint makes a duplicate replay a no-op, so a
 *    network timeout that actually succeeded on the server cannot produce a
 *    second receipt.
 *  • A 4xx is PERMANENT. Retrying a rejected quantity forever would drain the
 *    battery and hide a real problem, so the operation is marked FAILED with the
 *    server's own message and surfaced to the representative.
 */
@Singleton
class SyncEngine @Inject constructor(
    private val api: CortobaApi,
    private val dao: FieldOpsDao,
    private val scheduler: SyncScheduler,
    private val gson: Gson,
) {
    enum class Outcome { DONE, RETRY, IDLE, FAILED }

    suspend fun runOnce(): Outcome {
        val queue = dao.pending()
        if (queue.isEmpty()) return Outcome.IDLE
        scheduler.setRunning(true)
        return try {
            var hadRetryable = false
            for (op in queue) {
                val result = replay(op)
                if (result == Outcome.RETRY) hadRetryable = true
            }
            if (hadRetryable) Outcome.RETRY else Outcome.DONE
        } finally {
            scheduler.setRunning(false)
            // Synced rows are kept briefly so the UI can show «تمت المزامنة».
            dao.purgeSynced(System.currentTimeMillis() - SYNCED_RETENTION_MS)
        }
    }

    private suspend fun replay(op: PendingOperationEntity): Outcome {
        return try {
            when (op.type) {
                TYPE_RECEIPT -> {
                    val body = gson.fromJson(op.payloadJson, ReceiptConfirmRequest::class.java)
                    val response = apiCall { api.confirmReceipt(op.assignmentId, body) }
                    dao.markResult(op.clientUuid, SyncStatus.SYNCED.name, null)
                    if (!response.success) Outcome.RETRY else Outcome.DONE
                }
                TYPE_DELIVERY -> {
                    val body = gson.fromJson(op.payloadJson, DeliveryConfirmRequest::class.java)
                    val response = apiCall { api.confirmDelivery(op.assignmentId, body) }
                    dao.markResult(op.clientUuid, SyncStatus.SYNCED.name, null)
                    if (!response.success) Outcome.RETRY else Outcome.DONE
                }
                else -> {
                    dao.markResult(op.clientUuid, SyncStatus.FAILED.name, "نوع عملية غير معروف")
                    Outcome.FAILED
                }
            }
        } catch (e: ApiException) {
            when {
                // Revoked session: stop, the app will route the user to login.
                e.isUnauthorized -> {
                    dao.markResult(op.clientUuid, SyncStatus.PENDING.name, e.userMessage)
                    Outcome.RETRY
                }
                // Server rejected the data itself — retrying cannot help.
                e.isPermanent() -> {
                    dao.markResult(op.clientUuid, SyncStatus.FAILED.name, e.userMessage)
                    Outcome.FAILED
                }
                else -> {
                    dao.markResult(op.clientUuid, SyncStatus.PENDING.name, e.userMessage)
                    Outcome.RETRY
                }
            }
        }
    }

    /**
     * Tell the server what is queued (so it can acknowledge each UUID) and pull
     * back whatever changed. Called on app foreground.
     */
    suspend fun pushAndPull(): SyncRequest {
        val queue = dao.pending()
        val request = SyncRequest(
            operations = queue.map { op ->
                com.cortoba.fieldops.core.network.dto.SyncOperationRequest(
                    clientUuid = op.clientUuid,
                    type = op.type,
                    assignmentId = op.assignmentId,
                    payload = runCatching { gson.fromJson(op.payloadJson, Any::class.java) }.getOrNull(),
                )
            },
        )
        if (queue.isNotEmpty()) {
            runCatching { apiCall { api.sync(request) } }
        }
        return request
    }

    companion object {
        const val TYPE_RECEIPT = "receipt"
        const val TYPE_DELIVERY = "delivery"
        private const val SYNCED_RETENTION_MS = 24 * 60 * 60 * 1000L
    }
}
