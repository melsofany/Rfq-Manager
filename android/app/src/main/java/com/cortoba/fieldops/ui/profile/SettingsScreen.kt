package com.cortoba.fieldops.ui.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.ui.components.BrandActionButton
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber

/** Settings: change password, app info, sign out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignedOut: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var showPasswordDialog by remember { mutableStateOf(false) }

    LaunchedEffect(state.signedOut) { if (state.signedOut) onSignedOut() }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("الإعدادات", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "رجوع")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = CortobaBrown,
                    titleContentColor = CortobaCream,
                    navigationIconContentColor = CortobaCream,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).systemBarsPadding()) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { SectionTitle("الأمان") }

                item {
                    CreamCard {
                        Column {
                            Text(
                                text = "كلمة المرور",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                text = "تغيير كلمة المرور يُنهي جميع الجلسات المفتوحة على كل الأجهزة، " +
                                    "وسيُطلب منك تسجيل الدخول مرة أخرى.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                            Spacer(Modifier.height(10.dp))
                            OutlineActionButton(
                                text = "تغيير كلمة المرور",
                                icon = Icons.Default.Lock,
                                onClick = { showPasswordDialog = true },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                }

                if (state.error != null) {
                    item { ErrorBanner(state.error!!) }
                }
                if (state.successMessage != null) {
                    item {
                        CreamCard {
                            Text(
                                text = state.successMessage!!,
                                style = MaterialTheme.typography.bodyLarge,
                                color = CortobaBrown,
                            )
                        }
                    }
                }

                item { SectionTitle("عن التطبيق") }

                item {
                    CreamCard {
                        Column {
                            InfoRow("التطبيق", "العمليات الميدانية – قرطبة للتوريدات")
                            InfoRow("الإصدار", state.versionName)
                            InfoRow("الخادم", state.baseUrl)
                        }
                    }
                }

                item { SectionTitle("الجلسة") }

                item {
                    OutlineActionButton(
                        text = "تسجيل الخروج",
                        onClick = viewModel::logout,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                item {
                    Text(
                        text = "سيتم حذف العمليات المحفوظة محلياً عند تسجيل الخروج. " +
                            "تأكد من مزامنتها أولاً.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = StatusAmber,
                    )
                }

                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }

    if (showPasswordDialog) {
        ChangePasswordDialog(
            onDismiss = { showPasswordDialog = false },
            onSubmit = { current, new ->
                viewModel.changePassword(current, new)
                showPasswordDialog = false
            },
        )
    }
}

@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onSubmit: (String, String) -> Unit,
) {
    var current by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var localError by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("تغيير كلمة المرور") },
        text = {
            Column {
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text("كلمة المرور الحالية") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = { newPassword = it },
                    label = { Text("كلمة المرور الجديدة") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = confirm,
                    onValueChange = { confirm = it },
                    label = { Text("تأكيد كلمة المرور") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (localError != null) {
                    Spacer(Modifier.height(8.dp))
                    ErrorBanner(localError!!)
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    localError = when {
                        current.isBlank() -> "أدخل كلمة المرور الحالية"
                        newPassword.length < 6 -> "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل"
                        newPassword != confirm -> "كلمتا المرور غير متطابقتين"
                        else -> null
                    }
                    if (localError == null) onSubmit(current, newPassword)
                },
            ) {
                Text("تغيير", color = CortobaBrown)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("إلغاء") }
        },
    )
}
