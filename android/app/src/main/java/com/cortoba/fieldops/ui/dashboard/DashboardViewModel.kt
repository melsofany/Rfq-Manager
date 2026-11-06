package com.cortoba.fieldops.ui.dashboard

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.DashboardResponse
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class DashboardUiState(
    val loading: Boolean = true,
    val data: DashboardResponse? = null,
    val error: String? = null,
    val pendingSyncCount: Int = 0,
    val signedOut: Boolean = false,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(DashboardUiState())
    val state: StateFlow<DashboardUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            repository.observePendingCount().collect { count ->
                _state.update { it.copy(pendingSyncCount = count) }
            }
        }
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
