package com.cortoba.fieldops.core.session

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The authentication token, kept in EncryptedSharedPreferences (AES-256, key
 * held in the Android Keystore). A token in plain SharedPreferences would be
 * readable by any app with root or a backup extraction, so encryption here is
 * not optional.
 *
 * The token is also held in a StateFlow so the UI can react to a forced logout
 * (the server can revoke a session at any moment) without polling.
 */
@Singleton
class SessionStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val prefs: SharedPreferences? by lazy { openSecurePrefs() }

    private fun createEncrypted(): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    /**
     * Open the encrypted store, recovering from an unreadable one.
     *
     * The master key lives in the Android Keystore and can be invalidated (the
     * app restored onto a new device, an OS upgrade, or a corrupted key), which
     * makes `create` throw. Letting that escape would crash the app on launch —
     * unusable for a representative standing at a supplier. Instead the corrupt
     * file is discarded and rebuilt once; if the keystore is still unusable the
     * session degrades to in-memory only. A token is never written in cleartext
     * as a fallback, so a failed keystore costs a re-login, not a leaked session.
     *
     * `create` succeeding is NOT proof the store is readable: values are
     * decrypted lazily, so a file written with a now-missing key only fails when
     * a value is first read. That read is what must be guarded — a throw there
     * would escape this class's constructor and take the whole launch down.
     */
    private fun openSecurePrefs(): SharedPreferences? {
        val first = runCatching { createEncrypted() }.getOrNull()
        if (first != null && canRead(first)) return first
        // Either creation failed or the existing file is undecryptable: discard
        // and rebuild once. A token is never persisted in cleartext as a
        // fallback, so a lost key costs a re-login rather than a leaked session.
        runCatching { context.deleteSharedPreferences(PREFS_NAME) }
        val rebuilt = runCatching { createEncrypted() }.getOrNull()
        return rebuilt?.takeIf { canRead(it) }
    }

    /** True when every stored value can actually be decrypted. */
    private fun canRead(prefs: SharedPreferences): Boolean =
        runCatching { prefs.all }.isSuccess

    /** A read that treats an undecryptable store as "no value" instead of crashing. */
    private fun read(key: String): String? =
        runCatching { prefs?.getString(key, null) }.getOrNull()

    /** A write that never throws: losing a token is recoverable, a crash is not. */
    private fun write(block: (SharedPreferences.Editor) -> Unit) {
        runCatching {
            val editor = prefs?.edit() ?: return
            block(editor)
            editor.apply()
        }
    }

    private val _token = MutableStateFlow<String?>(null)
    val token: StateFlow<String?> = _token.asStateFlow()

    private val _signedIn = MutableStateFlow(false)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    /** Cached identity so the shell can render before the first network call. */
    private val _displayName = MutableStateFlow<String?>(null)
    val displayName: StateFlow<String?> = _displayName.asStateFlow()

    init {
        // Restore the last session synchronously: a cold start must not flash the
        // login screen for a representative who is already signed in. Every read
        // goes through [read], which degrades to "no value" if the store cannot
        // be decrypted rather than throwing out of this constructor.
        val stored = read(KEY_TOKEN)
        _token.value = stored
        _signedIn.value = stored != null
        _displayName.value = read(KEY_NAME)
    }

    fun currentToken(): String? = _token.value

    fun saveSession(token: String, fullName: String?, employeeNo: String?) {
        write {
            it.putString(KEY_TOKEN, token)
            it.putString(KEY_NAME, fullName)
            it.putString(KEY_EMPLOYEE_NO, employeeNo)
        }
        _token.value = token
        _displayName.value = fullName
        _signedIn.value = true
    }

    fun clear() {
        write { it.clear() }
        _token.value = null
        _displayName.value = null
        _signedIn.value = false
    }

    private companion object {
        const val PREFS_NAME = "cortoba_secure_prefs"
        const val KEY_TOKEN = "auth_token"
        const val KEY_NAME = "employee_name"
        const val KEY_EMPLOYEE_NO = "employee_no"
    }
}
