package com.cortoba.fieldops.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cortoba.fieldops.core.network.ApiException
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoginUiState(
    val employeeNo: String = "",
    val password: String = "",
    val passwordVisible: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val signedIn: Boolean = false,
) {
    /** The login button stays disabled until both fields are filled. */
    val canSubmit: Boolean get() = employeeNo.isNotBlank() && password.isNotBlank() && !loading
}

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val repository: FieldOpsRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(LoginUiState())
    val state: StateFlow<LoginUiState> = _state.asStateFlow()

    fun onEmployeeNoChange(value: String) {
        // The employee number is alphanumeric in HR; keep the operator's input
        // verbatim but trim the surrounding space so a paste still works.
        _state.update { it.copy(employeeNo = value.trim(), error = null) }
    }

    fun onPasswordChange(value: String) = _state.update { it.copy(password = value, error = null) }

    fun togglePasswordVisible() = _state.update { it.copy(passwordVisible = !it.passwordVisible) }

    fun submit() {
        val current = _state.value
        if (!current.canSubmit) return
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                repository.login(current.employeeNo, current.password)
                _state.update { it.copy(loading = false, signedIn = true) }
            } catch (e: ApiException) {
                _state.update { it.copy(loading = false, error = e.userMessage) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(loading = false, error = "تعذر تسجيل الدخول. برجاء المحاولة مرة أخرى")
                }
            }
        }
    }

    fun requestPasswordReset() {
        // The reset is handled by HR/the portal today, so the app explains the
        // route instead of pretending to send an email it cannot send.
        _state.update {
            it.copy(
                error = "لإعادة تعيين كلمة المرور، برجاء التواصل مع إدارة الموارد البشرية " +
                    "أو استخدام بوابة قرطبة لإعادة التعيين",
            )
        }
    }
}
