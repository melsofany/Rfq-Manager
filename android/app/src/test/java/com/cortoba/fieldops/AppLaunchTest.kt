package com.cortoba.fieldops

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/**
 * Launch smoke test.
 *
 * Two defects shipped past CI without a single failing check: the logo vector
 * was silently replaced by aapt2, and nothing here ever *ran* the app. A build
 * that compiles and a screen that renders are different claims, so this test
 * actually starts the [Application] and the launcher activity on the JVM and
 * fails on any exception thrown on the way to the first frame.
 *
 * Robolectric is used because there is no emulator in CI: it runs the real
 * merged resources, the real Hilt graph, and the real Compose tree, which is
 * where a launch crash lives.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class AppLaunchTest {

    /**
     * The Application is where a field app's launch most often dies: WorkManager
     * configuration, the encrypted session store, and Hilt's injection all run
     * here, before any UI exists. A failure here shows the user a themed window
     * that closes immediately — precisely the reported symptom.
     */
    @Test
    fun applicationStarts() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        // getApplicationContext() instantiates the app; assert it is ours so a
        // mis-configured android:name cannot pass this test silently.
        check(app is CortobaFieldOpsApp) { "Unexpected Application class: ${app.javaClass.name}" }
    }

    /**
     * Creates the launcher activity. This is the closest thing to tapping the
     * icon: it runs onCreate, builds the Compose tree, and resolves the theme,
     * the Cairo font family and the Cortoba logo drawable.
     */
    @Test
    fun mainActivityLaunches() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        controller.setup() // create -> start -> resume -> visible
        check(!controller.get().isFinishing) { "MainActivity finished immediately after launch" }
        controller.pause().stop().destroy()
    }
}
