package com.cortoba.fieldops.ui.profile

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.BuildConfig
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.util.AppUpdater
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The in-place update prompt state machine. */
sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val versionName: String, val downloadUrl: String) : UpdateState
    data object Downloading : UpdateState
    data class Failed(val message: String) : UpdateState
}

data class SettingsUiState(
    val versionName: String = BuildConfig.VERSION_NAME,
    val baseUrl: String = BuildConfig.API_BASE_URL,
    val error: String? = null,
    val successMessage: String? = null,
    val signedOut: Boolean = false,
    val updateState: UpdateState = UpdateState.Idle,
)

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private val _state = MutableStateFlow(SettingsUiState())
    val state: StateFlow<SettingsUiState> = _state.asStateFlow()

    init {
        checkForUpdate()
    }

    fun checkForUpdate() {
        viewModelScope.launch {
            _state.update { it.copy(updateState = UpdateState.Checking) }
            try {
                val latest = repository.latestVersion()
                val updateState =
                    if (latest.versionCode > BuildConfig.VERSION_CODE && !latest.downloadUrl.isNullOrBlank()) {
                        UpdateState.Available(latest.versionName, latest.downloadUrl)
                    } else {
                        UpdateState.UpToDate
                    }
                _state.update { it.copy(updateState = updateState) }
            } catch (e: ApiException) {
                _state.update { it.copy(updateState = UpdateState.Failed(e.userMessage)) }
            }
        }
    }

    fun downloadAndInstall(url: String) {
        viewModelScope.launch {
            _state.update { it.copy(updateState = UpdateState.Downloading) }
            try {
                val apk = AppUpdater.downloadApk(url, context)
                val opened = AppUpdater.install(context, apk)
                _state.update {
                    it.copy(
                        updateState = if (opened) UpdateState.Idle
                        else UpdateState.Failed("تعذر فتح مثبّت التطبيق"),
                    )
                }
            } catch (_: Exception) {
                _state.update { it.copy(updateState = UpdateState.Failed("تعذر تنزيل التحديث — برجاء المحاولة لاحقًا")) }
            }
        }
    }

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
