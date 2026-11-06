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
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
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
        // login screen for a representative who is already signed in.
        val stored = prefs.getString(KEY_TOKEN, null)
        _token.value = stored
        _signedIn.value = stored != null
        _displayName.value = prefs.getString(KEY_NAME, null)
    }

    fun currentToken(): String? = _token.value

    fun saveSession(token: String, fullName: String?, employeeNo: String?) {
        prefs.edit()
            .putString(KEY_TOKEN, token)
            .putString(KEY_NAME, fullName)
            .putString(KEY_EMPLOYEE_NO, employeeNo)
            .apply()
        _token.value = token
        _displayName.value = fullName
        _signedIn.value = true
    }

    fun clear() {
        prefs.edit().clear().apply()
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
