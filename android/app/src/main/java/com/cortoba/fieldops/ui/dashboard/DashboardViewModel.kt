package com.cortoba.fieldops.ui.dashboard

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.BuildConfig
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.DashboardResponse
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

/** A pending, downloadable app update surfaced on the dashboard. */
data class UpdatePrompt(
    val versionName: String,
    val downloadUrl: String,
    val downloading: Boolean = false,
    val error: String? = null,
)

data class DashboardUiState(
    val loading: Boolean = true,
    val data: DashboardResponse? = null,
    val error: String? = null,
    val pendingSyncCount: Int = 0,
    val signedOut: Boolean = false,
    val updatePrompt: UpdatePrompt? = null,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state: StateFlow<DashboardUiState> = _state.asStateFlow()

    init {
        load()
        checkForUpdate()
        viewModelScope.launch {
            repository.observePendingCount().collect { count ->
                _state.update { it.copy(pendingSyncCount = count) }
            }
        }
    }

    /** Ask the server for the latest version and, if newer, offer an update. */
    fun checkForUpdate() {
        viewModelScope.launch {
            try {
                val latest = repository.latestVersion()
                if (latest.versionCode > BuildConfig.VERSION_CODE && !latest.downloadUrl.isNullOrBlank()) {
                    _state.update { it.copy(updatePrompt = UpdatePrompt(latest.versionName, latest.downloadUrl)) }
                }
            } catch (_: ApiException) {
                // Silent: an update check must never interrupt the dashboard.
            }
        }
    }

    fun downloadAndInstall() {
        val prompt = _state.value.updatePrompt ?: return
        viewModelScope.launch {
            _state.update { it.copy(updatePrompt = prompt.copy(downloading = true, error = null)) }
            try {
                val apk = AppUpdater.downloadApk(prompt.downloadUrl, context)
                val opened = AppUpdater.install(context, apk)
                if (opened) {
                    _state.update { it.copy(updatePrompt = null) }
                } else {
                    _state.update {
                        it.copy(updatePrompt = prompt.copy(downloading = false, error = "تعذر فتح مثبّت التطبيق"))
                    }
                }
            } catch (_: Exception) {
                _state.update {
                    it.copy(updatePrompt = prompt.copy(downloading = false, error = "تعذر تنزيل التحديث"))
                }
            }
        }
    }

    fun dismissUpdate() {
        _state.update { it.copy(updatePrompt = null) }
    }

    fun load() {
        _state.update { it.copy(loading = it.data == null, error = null) }
        viewModelScope.launch {
            try {
                val data = repository.dashboard()
                _state.update { it.copy(loading = false, data = data) }
            } catch (e: ApiException) {
                if (e.isUnauthorized) {
                    // The session was revoked server-side. Send the user to login
                    // rather than leaving them on a screen that cannot load.
                    _state.update { it.copy(loading = false, signedOut = true) }
                } else {
                    _state.update { it.copy(loading = false, error = e.userMessage) }
                }
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
