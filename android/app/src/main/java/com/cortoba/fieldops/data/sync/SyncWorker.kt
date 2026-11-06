package com.cortoba.fieldops.data.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.cortoba.fieldops.core.network.ApiException
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Background synchronisation.
 *
 * Constraints require connectivity, so WorkManager wakes the worker the moment
 * the phone regains signal — the representative never has to press "retry".
 * A one-shot run is also enqueued explicitly after each offline save, so the
 * common case (save offline, walk back into coverage) syncs immediately instead
 * of waiting for the periodic window.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val syncEngine: SyncEngine,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return when (syncEngine.runOnce()) {
            SyncEngine.Outcome.DONE -> Result.success()
            SyncEngine.Outcome.RETRY -> Result.retry()
            // Nothing to do, or a permanent server rejection: no point retrying
            // forever. The operation is surfaced to the user as failed instead.
            SyncEngine.Outcome.IDLE, SyncEngine.Outcome.FAILED -> Result.success()
        }
    }
}

@Singleton
class SyncScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    /** Whether a sync is running right now, for the UI banner. */
    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    fun schedulePeriodic() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    /** Kick an immediate attempt (after an offline save, or a manual refresh). */
    fun syncNow() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            ONESHOT_WORK,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun setRunning(value: Boolean) {
        _running.value = value
    }

    private companion object {
        const val PERIODIC_WORK = "cortoba_field_ops_sync_periodic"
        const val ONESHOT_WORK = "cortoba_field_ops_sync_oneshot"
    }
}

/** Raised when the outbox must stop retrying (e.g. the session was revoked). */
internal fun ApiException.isPermanent(): Boolean = statusCode in 400..499
