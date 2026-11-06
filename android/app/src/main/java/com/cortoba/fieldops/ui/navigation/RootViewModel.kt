package com.cortoba.fieldops.ui.navigation

import androidx.lifecycle.ViewModel
import com.cortoba.fieldops.core.session.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject

/**
 * Decides the graph's start destination. The stored token is read synchronously
 * so an already-signed-in representative never sees the login screen flash.
 */
@HiltViewModel
class RootViewModel @Inject constructor(
    sessionStore: SessionStore,
) : ViewModel() {
    val signedIn: StateFlow<Boolean> = sessionStore.signedIn
}
