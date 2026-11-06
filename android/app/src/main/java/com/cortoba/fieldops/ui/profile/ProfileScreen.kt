package com.cortoba.fieldops.ui.profile

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Badge
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.util.formatDateTime
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.SyncStatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber

/** Employee profile, own operation history and the offline queue. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit,
    onSignedOut: () -> Unit,
    viewModel: ProfileViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(state.signedOut) { if (state.signedOut) onSignedOut() }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("الملف الشخصي", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "رجوع")
                    }
                },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "الإعدادات")
                    }
                    IconButton(onClick = viewModel::logout) {
                        Icon(Icons.Default.Logout, contentDescription = "تسجيل الخروج")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = CortobaBrown,
                    titleContentColor = CortobaCream,
                    navigationIconContentColor = CortobaCream,
                    actionIconContentColor = CortobaCream,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).systemBarsPadding()) {
            val profile = state.profile
            when {
                state.loading && profile == null -> LoadingBox(Modifier.fillMaxSize())

                profile == null -> Column(Modifier.padding(20.dp)) {
                    if (state.error != null) ErrorBanner(state.error!!)
                }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                modifier = Modifier
                                    .size(64.dp)
                                    .clip(CircleShape)
                                    .background(CortobaBrown),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = profile.fullName.trim().take(1),
                                    style = MaterialTheme.typography.headlineSmall,
                                    color = CortobaCream,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                            Column(Modifier.padding(start = 14.dp)) {
                                Text(
                                    text = profile.fullName,
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Bold,
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Icon(
                                        Icons.Default.Badge,
                                        contentDescription = null,
                                        tint = CortobaBrown,
                                        modifier = Modifier.size(16.dp),
                                    )
                                    Text(
                                        text = "الرقم الوظيفي: ${profile.employeeNo}",
                                        style = MaterialTheme.typography.bodyLarge,
                                        modifier = Modifier.padding(start = 6.dp),
                                    )
                                }
                            }
                        }
                    }

                    item {
                        CreamCard {
                            Column {
                                InfoRow("المسمى الوظيفي", profile.jobTitle)
                                InfoRow("القسم", profile.department)
                                InfoRow("الجوال", profile.phone)
                                InfoRow(
                                    "مندوب ميداني",
                                    if (profile.isFieldRepresentative) "نعم" else "لا",
                                )
                            }
                        }
                    }

                    if (state.pending.isNotEmpty()) {
                        item { SectionTitle("عمليات في انتظار المزامنة") }
                        item {
                            OutlineActionButton(
                                text = "محاولة المزامنة الآن",
                                icon = Icons.Default.Sync,
                                onClick = viewModel::retrySync,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        items(state.pending, key = { it.clientUuid }) { op ->
                            CreamCard {
                                Column {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = if (op.type == "receipt") "استلام" else "تسليم",
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.weight(1f),
                                        )
                                        SyncStatusChip(op.status)
                                    }
                                    InfoRow("المهمة", "#${op.assignmentId}")
                                    InfoRow("التاريخ", formatDateTime(java.time.Instant.ofEpochMilli(op.createdAt).toString()))
                                    if (!op.lastError.isNullOrBlank()) {
                                        InfoRow("السبب", op.lastError)
                                    }
                                }
                            }
                        }
                    }

                    state.history?.let { history ->
                        if (history.receipts.isNotEmpty()) {
                            item { SectionTitle("سجل الاستلامات") }
                            items(history.receipts, key = { "r-${it.id}" }) { receipt ->
                                CreamCard {
                                    Column {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Icon(
                                                Icons.Default.History,
                                                contentDescription = null,
                                                tint = CortobaBrown,
                                                modifier = Modifier.size(18.dp),
                                            )
                                            Text(
                                                text = receipt.description ?: "استلام",
                                                style = MaterialTheme.typography.titleMedium,
                                                modifier = Modifier.padding(start = 8.dp),
                                            )
                                        }
                                        InfoRow("أمر الشراء", receipt.poNo)
                                        InfoRow("المستلم", formatQty(receipt.receivedQty))
                                        InfoRow("المقبول", formatQty(receipt.acceptedQty))
                                        InfoRow("التاريخ", formatDateTime(receipt.at))
                                    }
                                }
                            }
                        }

                        if (history.deliveries.isNotEmpty()) {
                            item { SectionTitle("سجل التسليمات") }
                            items(history.deliveries, key = { "d-${it.id}" }) { delivery ->
                                CreamCard {
                                    Column {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Icon(
                                                Icons.Default.History,
                                                contentDescription = null,
                                                tint = CortobaBrown,
                                                modifier = Modifier.size(18.dp),
                                            )
                                            Text(
                                                text = delivery.description ?: "تسليم",
                                                style = MaterialTheme.typography.titleMedium,
                                                modifier = Modifier.padding(start = 8.dp),
                                            )
                                        }
                                        InfoRow("أمر العميل", delivery.customerPoNo)
                                        InfoRow("المسلّم", formatQty(delivery.deliveredQty))
                                        InfoRow("التاريخ", formatDateTime(delivery.at))
                                    }
                                }
                            }
                        }
                    }

                    if (state.error != null) {
                        item { ErrorBanner(state.error!!) }
                    }

                    item {
                        TextButton(onClick = viewModel::logout, modifier = Modifier.fillMaxWidth()) {
                            Text("تسجيل الخروج", color = StatusAmber)
                        }
                    }

                    item { Spacer(Modifier.height(16.dp)) }
                }
            }
        }
    }
}
