package com.cortoba.fieldops

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.cortoba.fieldops.core.location.LocationProvider
import com.cortoba.fieldops.data.sync.SyncScheduler
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point.
 *
 * Implements [Configuration.Provider] so WorkManager can construct the
 * Hilt-injected SyncWorker — without this the sync worker has no dependencies
 * and every replay fails.
 */
@HiltAndroidApp
class CortobaFieldOpsApp : Application(), Configuration.Provider {

    @Inject lateinit var workerFactory: HiltWorkerFactory
    @Inject lateinit var syncScheduler: SyncScheduler

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()

    override fun onCreate() {
        super.onCreate()
        LocationProvider.init(this)
        // A queued offline operation is retried the moment connectivity returns,
        // without the representative reopening the app.
        syncScheduler.schedulePeriodic()
    }
}
