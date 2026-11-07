package com.cortoba.fieldops.core.util

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Download and install a side-loaded APK update in place.
 *
 * The APK is written to the cache directory and handed to the system installer
 * through a FileProvider. Because every build is signed with the same committed
 * key, Android can install it over the current one without
 * INSTALL_FAILED_UPDATE_INCOMPATIBLE.
 */
object AppUpdater {

    private const val APK_FILE_NAME = "update.apk"

    /** Download the APK to the app cache and return it. */
    suspend fun downloadApk(url: String, context: Context): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "apk").apply { mkdirs() }
        val target = File(dir, APK_FILE_NAME)
        val connection = java.net.URL(url).openConnection() as HttpURLConnection
        connection.setRequestProperty("User-Agent", "cortoba-fieldops")
        connection.instanceFollowRedirects = true
        connection.connectTimeout = 30_000
        connection.readTimeout = 120_000
        try {
            connection.inputStream.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
        } finally {
            connection.disconnect()
        }
        target
    }

    /** Open the system installer for the given APK. False if no handler exists. */
    fun install(context: Context, apk: File): Boolean {
        return try {
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apk,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
