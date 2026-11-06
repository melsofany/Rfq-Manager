package com.cortoba.fieldops.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import kotlinx.coroutines.flow.Flow

/**
 * Local cache + offline queue. Two jobs, deliberately separate:
 *
 *  • Cache tables hold the last server payload so the representative can open a
 *    task with no signal. They are READ-ONLY projections — never a second source
 *    of truth. A task is never "done" locally; only the server decides that.
 *  • [PendingOperationEntity] is the outbox. An operation recorded offline is
 *    written here with a client UUID and replayed on reconnect; the server's
 *    unique (employee, clientUuid) index makes the replay idempotent.
 */

@Entity(tableName = "cached_pickup_tasks")
data class CachedPickupTaskEntity(
    @PrimaryKey val poId: Int,
    val assignmentId: Int?,
    val payloadJson: String,
    val cachedAt: Long,
)

@Entity(tableName = "cached_pickup_detail")
data class CachedPickupDetailEntity(
    @PrimaryKey val assignmentId: Int,
    val payloadJson: String,
    val cachedAt: Long,
)

@Entity(tableName = "cached_delivery_tasks")
data class CachedDeliveryTaskEntity(
    @PrimaryKey val assignmentId: Int,
    val payloadJson: String,
    val cachedAt: Long,
)

@Entity(tableName = "cached_delivery_detail")
data class CachedDeliveryDetailEntity(
    @PrimaryKey val assignmentId: Int,
    val payloadJson: String,
    val cachedAt: Long,
)

@Entity(tableName = "cached_notifications")
data class CachedNotificationEntity(
    @PrimaryKey val id: Int,
    val payloadJson: String,
    val cachedAt: Long,
)

/** Status values surfaced to the representative, in their own words. */
enum class SyncStatus { SAVED_LOCALLY, PENDING, SYNCED, FAILED }

@Entity(tableName = "pending_operations")
data class PendingOperationEntity(
    /** Client-generated UUID: the idempotency key for the whole submission. */
    @PrimaryKey val clientUuid: String,
    /** receipt | delivery */
    val type: String,
    val assignmentId: Int,
    /** Serialised confirm request body. */
    val payloadJson: String,
    /** SAVED_LOCALLY | PENDING | SYNCED | FAILED */
    val status: String = SyncStatus.SAVED_LOCALLY.name,
    val attempts: Int = 0,
    val lastError: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
)

class SyncStatusConverter {
    @TypeConverter fun toName(status: SyncStatus): String = status.name
    @TypeConverter fun fromName(name: String): SyncStatus =
        runCatching { SyncStatus.valueOf(name) }.getOrDefault(SyncStatus.SAVED_LOCALLY)
}

@Dao
interface FieldOpsDao {
    // ── Cache reads ───────────────────────────────────────────────────────
    @Query("SELECT * FROM cached_pickup_tasks ORDER BY cachedAt DESC")
    fun observePickupTasks(): Flow<List<CachedPickupTaskEntity>>

    @Query("SELECT * FROM cached_pickup_tasks ORDER BY cachedAt DESC")
    suspend fun pickupTasks(): List<CachedPickupTaskEntity>

    @Query("SELECT * FROM cached_pickup_detail WHERE assignmentId = :id LIMIT 1")
    suspend fun pickupDetail(id: Int): CachedPickupDetailEntity?

    @Query("SELECT * FROM cached_delivery_tasks ORDER BY cachedAt DESC")
    fun observeDeliveryTasks(): Flow<List<CachedDeliveryTaskEntity>>

    @Query("SELECT * FROM cached_delivery_tasks ORDER BY cachedAt DESC")
    suspend fun deliveryTasks(): List<CachedDeliveryTaskEntity>

    @Query("SELECT * FROM cached_delivery_detail WHERE assignmentId = :id LIMIT 1")
    suspend fun deliveryDetail(id: Int): CachedDeliveryDetailEntity?

    @Query("SELECT * FROM cached_notifications ORDER BY cachedAt DESC")
    fun observeNotifications(): Flow<List<CachedNotificationEntity>>

    @Query("SELECT * FROM cached_notifications ORDER BY cachedAt DESC")
    suspend fun notifications(): List<CachedNotificationEntity>

    // ── Cache writes ──────────────────────────────────────────────────────
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun cachePickupTasks(rows: List<CachedPickupTaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun cachePickupDetail(row: CachedPickupDetailEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun cacheDeliveryTasks(rows: List<CachedDeliveryTaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun cacheDeliveryDetail(row: CachedDeliveryDetailEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun cacheNotifications(rows: List<CachedNotificationEntity>)

    @Query("DELETE FROM cached_pickup_tasks")
    suspend fun clearPickupTasks()

    @Query("DELETE FROM cached_delivery_tasks")
    suspend fun clearDeliveryTasks()

    @Query("DELETE FROM cached_notifications")
    suspend fun clearNotifications()

    // ── Outbox ────────────────────────────────────────────────────────────
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun enqueue(operation: PendingOperationEntity)

    @Query("SELECT * FROM pending_operations WHERE status != 'SYNCED' ORDER BY createdAt ASC")
    suspend fun pending(): List<PendingOperationEntity>

    @Query("SELECT * FROM pending_operations ORDER BY createdAt DESC LIMIT 200")
    fun observePending(): Flow<List<PendingOperationEntity>>

    @Query("UPDATE pending_operations SET status = :status, attempts = attempts + 1, lastError = :error, updatedAt = :now WHERE clientUuid = :uuid")
    suspend fun markResult(uuid: String, status: String, error: String?, now: Long = System.currentTimeMillis())

    @Query("DELETE FROM pending_operations WHERE status = 'SYNCED' AND updatedAt < :before")
    suspend fun purgeSynced(before: Long)

    @Query("SELECT COUNT(*) FROM pending_operations WHERE status != 'SYNCED'")
    fun observePendingCount(): Flow<Int>

    /** Wiped on logout so a shared device leaks nothing. */
    @Query("DELETE FROM pending_operations")
    suspend fun clearPending()
}

@Database(
    entities = [
        CachedPickupTaskEntity::class,
        CachedPickupDetailEntity::class,
        CachedDeliveryTaskEntity::class,
        CachedDeliveryDetailEntity::class,
        CachedNotificationEntity::class,
        PendingOperationEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
@TypeConverters(SyncStatusConverter::class)
abstract class FieldOpsDatabase : RoomDatabase() {
    abstract fun dao(): FieldOpsDao
}
