package com.cortoba.fieldops.core.session

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Regression test for the launch crash.
 *
 * The store decrypts lazily: `EncryptedSharedPreferences.create` succeeds even
 * when the file on disk was written with a Keystore key that no longer exists,
 * and the failure only surfaces when a value is first read. The old code guarded
 * `create` but not the read, so `prefs?.getString(...)` threw out of the
 * constructor — which Hilt runs while building the first screen, killing the app
 * before a frame was drawn.
 *
 * The assertion is deliberately "constructing must not throw", not "the value
 * must round-trip": an unavailable or corrupt Keystore is a legitimate state on
 * a real device, and the contract is that it costs a re-login, never a crash.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class SessionStoreTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val prefsName = "cortoba_secure_prefs"

    @After
    fun tearDown() {
        context.deleteSharedPreferences(prefsName)
    }

    @Test
    fun constructsWhenStoredDataIsNotDecryptable() {
        // A plain file under the encrypted store's name holds data the encrypted
        // layer did not write, so every read fails to decrypt.
        context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
            .edit()
            .putString("auth_token", "not-ciphertext")
            .commit()

        val store = SessionStore(context)

        assertNull("an undecryptable token must read as absent", store.token.value)
        assertFalse("a corrupt session must sign out, not crash", store.signedIn.value)
    }

    @Test
    fun constructsWithNoStoredSession() {
        val store = SessionStore(context)

        assertNull(store.token.value)
        assertFalse(store.signedIn.value)
    }

    @Test
    fun clearAndSaveNeverThrow() {
        val store = SessionStore(context)

        store.saveSession(token = "token-123", fullName = "أحمد", employeeNo = "E-1")
        store.clear()

        assertNull(store.token.value)
        assertFalse(store.signedIn.value)
    }
}
