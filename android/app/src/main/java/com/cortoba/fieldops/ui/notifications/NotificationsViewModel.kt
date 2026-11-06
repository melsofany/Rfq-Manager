package com.cortoba.fieldops.ui.notifications

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.core.network.dto.NotificationDto
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class NotificationsUiState(
    val loading: Boolean = true,
    val items: List<NotificationDto> = emptyList(),
    val error: String? = null,
    val fromCache: Boolean = false,
)

@HiltViewModel
class NotificationsViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(NotificationsUiState())
    val state: StateFlow<NotificationsUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.update { it.copy(loading = it.items.isEmpty(), error = null) }
        viewModelScope.launch {
            try {
                val result = repository.notifications()
                _state.update {
                    it.copy(loading = false, items = result.value, fromCache = result.fromCache)
                }
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = e.userMessage) }
            }
        }
    }

    fun markRead(id: Int) {
        viewModelScope.launch {
            runCatching { repository.markNotificationRead(id) }
            // Update locally so the badge clears immediately; the server is the
            // authority on the next refresh.
            _state.update { state ->
                state.copy(items = state.items.map { if (it.id == id) it.copy(read = true) else it })
            }
        }
    }

    fun markAllRead() {
        viewModelScope.launch {
            runCatching { repository.markAllNotificationsRead() }
            _state.update { state ->
                state.copy(items = state.items.map { it.copy(read = true) })
            }
        }
    }
}
