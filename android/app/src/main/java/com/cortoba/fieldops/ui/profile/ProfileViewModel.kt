package com.cortoba.fieldops.ui.profile

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.HistoryResponse
import com.cortoba.fieldops.core.network.dto.ProfileResponse
import com.cortoba.fieldops.data.local.PendingOperationEntity
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class ProfileUiState(
    val loading: Boolean = true,
    val profile: ProfileResponse? = null,
    val history: HistoryResponse? = null,
    val pending: List<PendingOperationEntity> = emptyList(),
    val error: String? = null,
    val signedOut: Boolean = false,
)

@HiltViewModel
class ProfileViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(ProfileUiState())
    val state: StateFlow<ProfileUiState> = _state.asStateFlow()

    init {
        load()
        viewModelScope.launch {
            repository.observePending().collect { pending ->
                _state.update { it.copy(pending = pending) }
            }
        }
    }

    fun load() {
        _state.update { it.copy(loading = it.profile == null, error = null) }
        viewModelScope.launch {
            try {
                val profile = repository.profile()
                val history = runCatching { repository.history() }.getOrNull()
                _state.update { it.copy(loading = false, profile = profile, history = history) }
            } catch (e: ApiException) {
                if (e.isUnauthorized) {
                    _state.update { it.copy(loading = false, signedOut = true) }
                } else {
                    _state.update { it.copy(loading = false, error = e.userMessage) }
                }
            }
        }
    }

    fun retrySync() {
        viewModelScope.launch { repository.retrySync() }
    }

    fun logout() {
        viewModelScope.launch {
            repository.logout()
            _state.update { it.copy(signedOut = true) }
        }
    }
}
