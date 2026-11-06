package com.cortoba.fieldops.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Badge
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCoral
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.CortobaYellow
import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusGreen

/**
 * Welcome dashboard. Three cards only — الاستلامات، التسليمات، العهدة المالية —
 * because a field representative needs to answer "what do I do next" in one
 * glance, not read a report.
 */
@Composable
fun DashboardScreen(
    onOpenPickups: () -> Unit,
    onOpenDeliveries: () -> Unit,
    onOpenCustody: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenProfile: () -> Unit,
    onSignedOut: () -> Unit,
    viewModel: DashboardViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(state.signedOut) {
        if (state.signedOut) onSignedOut()
    }

    Box(modifier = Modifier.fillMaxSize().background(CortobaCream).systemBarsPadding()) {
        when {
            state.loading && state.data == null -> LoadingBox(modifier = Modifier.fillMaxSize())
            state.data == null -> {
                Column(Modifier.fillMaxSize().padding(20.dp)) {
                    if (state.error != null) ErrorBanner(state.error!!)
                }
            }
            else -> {
                val data = state.data!!
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    TopBar(
                        unread = data.indicators.unreadNotifications,
                        pendingSync = state.pendingSyncCount,
                        onOpenNotifications = onOpenNotifications,
                        onOpenProfile = onOpenProfile,
                        onLogout = viewModel::logout,
                    )

                    WelcomeCard(
                        name = data.employee.fullName,
                        employeeNo = data.employee.employeeNo,
                        jobTitle = data.employee.jobTitle,
                        department = data.employee.department,
                        today = data.today,
                    )

                    Spacer(Modifier.height(16.dp))

                    ModuleCard(
                        title = "الاستلامات",
                        icon = Icons.Default.LocalShipping,
                        accent = CortobaBrown,
                        lines = listOf(
                            "مهام جديدة: ${data.indicators.receiptNew}",
                            "قيد التنفيذ: ${data.indicators.receiptInProgress}",
                            "بانتظار استلامها: ${data.indicators.pendingReceiptItems} بند",
                            "مكتملة: ${data.indicators.receiptCompleted}",
                        ),
                        onClick = onOpenPickups,
                    )

                    Spacer(Modifier.height(12.dp))

                    ModuleCard(
                        title = "التسليمات",
                        icon = Icons.Default.CheckCircle,
                        accent = StatusGreen,
                        lines = listOf(
                            "مهام جديدة: ${data.indicators.deliveryNew}",
                            "قيد التنفيذ: ${data.indicators.deliveryInProgress}",
                            "جاهز للتسليم: ${data.indicators.pendingDeliveryItems} بند",
                            "مكتملة: ${data.indicators.deliveryCompleted}",
                        ),
                        onClick = onOpenDeliveries,
                    )

                    Spacer(Modifier.height(12.dp))

                    ModuleCard(
                        title = "العهدة المالية",
                        icon = Icons.Default.AccountBalanceWallet,
                        accent = StatusAmber,
                        lines = listOf("قريباً", "سيتم تفعيل الوحدة في مرحلة لاحقة"),
                        onClick = onOpenCustody,
                        badge = "قريباً",
                    )

                    if (state.pendingSyncCount > 0) {
                        Spacer(Modifier.height(16.dp))
                        PendingSyncCard(
                            count = state.pendingSyncCount,
                            onRetry = viewModel::load,
                        )
                    }

                    if (state.error != null) {
                        Spacer(Modifier.height(12.dp))
                        ErrorBanner(state.error!!)
                    }

                    Spacer(Modifier.height(24.dp))
                }
            }
        }
    }
}

@Composable
private fun TopBar(
    unread: Int,
    pendingSync: Int,
    onOpenNotifications: () -> Unit,
    onOpenProfile: () -> Unit,
    onLogout: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "قرطبة للتوريدات",
            style = MaterialTheme.typography.titleLarge,
            color = CortobaBrown,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.weight(1f),
        )
        if (pendingSync > 0) {
            Icon(
                imageVector = Icons.Default.Sync,
                contentDescription = "عمليات في انتظار المزامنة",
                tint = StatusAmber,
                modifier = Modifier.size(22.dp),
            )
            Text(
                text = "$pendingSync",
                style = MaterialTheme.typography.labelLarge,
                color = StatusAmber,
                modifier = Modifier.padding(start = 4.dp, end = 8.dp),
            )
        }
        Box {
            IconButton(onClick = onOpenNotifications) {
                Icon(Icons.Default.Notifications, contentDescription = "الإشعارات", tint = CortobaBrown)
            }
            if (unread > 0) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(6.dp)
                        .size(18.dp)
                        .clip(CircleShape)
                        .background(CortobaCoral),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (unread > 9) "9+" else "$unread",
                        style = MaterialTheme.typography.labelLarge,
                        color = CortobaCream,
                    )
                }
            }
        }
        IconButton(onClick = onOpenProfile) {
            Icon(Icons.Default.Person, contentDescription = "الملف الشخصي", tint = CortobaBrown)
        }
        IconButton(onClick = onLogout) {
            Icon(Icons.Default.Logout, contentDescription = "تسجيل الخروج", tint = CortobaBrown)
        }
    }
}

@Composable
private fun WelcomeCard(
    name: String,
    employeeNo: String,
    jobTitle: String?,
    department: String?,
    today: String?,
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = CortobaBrown,
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Text(
                text = "أهلاً وسهلاً، $name",
                style = MaterialTheme.typography.headlineSmall,
                color = CortobaCream,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "مرحباً بك في نظام العمليات الميدانية – قرطبة للتوريدات",
                style = MaterialTheme.typography.bodyMedium,
                color = CortobaCream.copy(alpha = 0.9f),
                modifier = Modifier.padding(top = 6.dp),
            )

            Spacer(Modifier.height(14.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Badge, contentDescription = null, tint = CortobaYellow, modifier = Modifier.size(18.dp))
                Text(
                    text = "الرقم الوظيفي: $employeeNo",
                    style = MaterialTheme.typography.bodyLarge,
                    color = CortobaCream,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }

            if (!jobTitle.isNullOrBlank() || !department.isNullOrBlank()) {
                Text(
                    text = listOfNotNull(jobTitle, department).filter { it.isNotBlank() }.joinToString(" — "),
                    style = MaterialTheme.typography.bodyMedium,
                    color = CortobaCream.copy(alpha = 0.85f),
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Icon(Icons.Default.CalendarMonth, contentDescription = null, tint = CortobaYellow, modifier = Modifier.size(18.dp))
                Text(
                    text = today ?: "—",
                    style = MaterialTheme.typography.bodyMedium,
                    color = CortobaCream.copy(alpha = 0.9f),
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun ModuleCard(
    title: String,
    icon: ImageVector,
    accent: androidx.compose.ui.graphics.Color,
    lines: List<String>,
    onClick: () -> Unit,
    badge: String? = null,
) {
    Surface(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
    ) {
        Row(modifier = Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(accent.copy(alpha = 0.14f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = accent, modifier = Modifier.size(28.dp))
            }

            Column(modifier = Modifier.weight(1f).padding(start = 14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = title,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                        fontWeight = FontWeight.Bold,
                    )
                    if (badge != null) {
                        Text(
                            text = badge,
                            style = MaterialTheme.typography.labelLarge,
                            color = accent,
                            modifier = Modifier.padding(start = 10.dp),
                        )
                    }
                }
                lines.forEach { line ->
                    Text(
                        text = line,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 2.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun PendingSyncCard(count: Int, onRetry: () -> Unit) {
    Surface(
        onClick = onRetry,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = StatusAmber.copy(alpha = 0.14f),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Sync, contentDescription = null, tint = StatusAmber)
            Text(
                text = "$count عملية محفوظة محلياً في انتظار المزامنة",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f).padding(start = 10.dp),
            )
            Text(
                text = "تحديث",
                style = MaterialTheme.typography.labelLarge,
                color = StatusAmber,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}
