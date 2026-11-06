package com.cortoba.fieldops.ui.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.BuildConfig
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val versionName: String = BuildConfig.VERSION_NAME,
    val baseUrl: String = BuildConfig.API_BASE_URL,
    val error: String? = null,
    val successMessage: String? = null,
    val signedOut: Boolean = false,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    fun changePassword(current: String, newPassword: String) {
        viewModelScope.launch {
            try {
                repository.changePassword(current, newPassword)
                // The server revokes every session on a password change, so the
                // app must re-authenticate rather than pretend it is still signed in.
                _state.update {
                    it.copy(
                        error = null,
                        successMessage = "تم تغيير كلمة المرور. برجاء تسجيل الدخول من جديد",
                        signedOut = true,
                    )
                }
            } catch (e: ApiException) {
                _state.update { it.copy(error = e.userMessage, successMessage = null) }
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            repository.logout()
            _state.update { it.copy(signedOut = true) }
        }
    }
}
