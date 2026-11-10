package com.cortoba.fieldops.ui.pickups

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupAllocation
import com.cortoba.fieldops.core.util.dialPhone
import com.cortoba.fieldops.core.util.formatDate
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.core.util.openMap
import com.cortoba.fieldops.ui.components.BrandActionButton
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.PaymentStatusChip
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.StatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusBlue
import com.cortoba.fieldops.ui.theme.StatusGreen

/**
 * One pickup task, received in place.
 *
 * The supplier data and the receiving form live on the same screen: the rep
 * opens a supplier square, sees the header (with the PO number), taps call or
 * map, and can immediately «استلام الكل»/«رفض الكل» or handle each item with
 * full / partial / reject. No separate "start receiving" step.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickupDetailScreen(
    assignmentId: Int,
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: PickupViewModel = hiltViewModel(),
) {
    val detailState by viewModel.detail.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(assignmentId) { viewModel.loadDetail(assignmentId) }

    // The all-of-task actions still ask once, because a stray tap would settle
    // every line at once. The per-line buttons do not: their tap is the action.
    var showConfirmAll by remember { mutableStateOf(false) }
    var showRejectAll by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("الاستلام", fontWeight = FontWeight.Bold) },
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
            when {
                detailState.loading && detailState.data == null -> LoadingBox(Modifier.fillMaxSize())

                detailState.data == null -> Column(Modifier.padding(20.dp)) {
                    if (detailState.error != null) ErrorBanner(detailState.error!!)
                }

                else -> {
                    val data = detailState.data!!
                    val summary = viewModel.summaryFor(form.entries)

                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (detailState.fromCache) {
                            item { OfflineBanner(detailState.cachedAt) }
                        }

                        item {
                            CreamCard {
                                Column {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            text = data.supplier?.name ?: "مورد غير محدد",
                                            style = MaterialTheme.typography.titleLarge,
                                            fontWeight = FontWeight.Bold,
                                            modifier = Modifier.weight(1f),
                                        )
                                        Column(horizontalAlignment = Alignment.End) {
                                            StatusChip(data.status)
                                            Spacer(Modifier.height(6.dp))
                                            PaymentStatusChip(data.paymentStatus)
                                        }
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    InfoRow("تاريخ الأمر", formatDate(data.po?.poDate))
                                    InfoRow("المسؤول", data.representativeName)
                                    if (data.executorRole == "delegate") {
                                        InfoRow("ملاحظة", "منفّذ بالإنابة")
                                    }
                                    InfoRow("هاتف المورد", data.supplier?.phone)
                                    InfoRow("جهة الاتصال", data.supplier?.contactPerson)
                                    InfoRow("العنوان", data.supplier?.address)
                                    if (!data.po?.notes.isNullOrBlank()) {
                                        InfoRow("ملاحظات", data.po?.notes)
                                    }
                                }
                            }
                        }

                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlineActionButton(
                                    text = "الاتصال بالمورد",
                                    icon = Icons.Default.Call,
                                    onClick = { dialPhone(context, data.supplier?.phone) },
                                    modifier = Modifier.weight(1f),
                                )
                                OutlineActionButton(
                                    text = "الموقع على الخريطة",
                                    icon = Icons.Default.LocationOn,
                                    onClick = { openMap(context, data.supplier?.address) },
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }

                        if (data.items.isNotEmpty()) {
                            item {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    BrandActionButton(
                                        text = "استلام الكل",
                                        enabled = !form.submitting,
                                        onClick = { showConfirmAll = true },
                                        modifier = Modifier.weight(1f),
                                    )
                                    OutlineActionButton(
                                        text = "رفض الكل",
                                        onClick = { showRejectAll = true },
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }

                            item { SectionTitle("الأصناف المطلوبة") }

                            items(data.items, key = { it.groupKey }) { group ->
                                ReceiptGroupCard(
                                    group = group,
                                    entries = form.entries.filter { it.groupKey == group.groupKey },
                                    submitting = form.submitting,
                                    onReceivedChange = viewModel::onReceivedQtyChange,
                                    onRejectedChange = viewModel::onRejectedQtyChange,
                                    onReasonChange = viewModel::onRejectionReasonChange,
                                    onReceiveFull = { viewModel.receiveLineFull(assignmentId, it) },
                                    onReceivePartial = { viewModel.receiveLinePartial(assignmentId, it) },
                                    onReject = { viewModel.rejectLine(assignmentId, it) },
                                )
                            }

                            if (form.error != null) {
                                item { ErrorBanner(form.error!!) }
                            }

                            if (form.submitting) {
                                item {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.Center,
                                    ) {
                                        CircularProgressIndicator(color = CortobaBrown)
                                    }
                                }
                            }
                        } else {
                            item {
                                com.cortoba.fieldops.ui.components.EmptyState(
                                    title = "لا توجد أصناف للاستلام",
                                    subtitle = "تم استلام كل الكميات المطلوبة لهذا الأمر.",
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (showConfirmAll) {
        AlertDialog(
            onDismissRequest = { showConfirmAll = false },
            title = { Text("استلام الكل") },
            text = { Text("سيتم تسجيل استلام كل الأصناف بالكمية المطلوبة كاملة. هل تريد المتابعة؟") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showConfirmAll = false
                        viewModel.receiveAll(assignmentId)
                    },
                ) {
                    Text("استلام الكل", color = CortobaBrown)
                }
            },
            dismissButton = {
                TextButton(onClick = { showConfirmAll = false }) { Text("رجوع") }
            },
        )
    }

    if (showRejectAll) {
        RejectionReasonDialog(
            title = "رفض الكل",
            message = "سيتم تسجيل رفض كل الأصناف بالسبب المختار. هل تريد المتابعة؟",
            onDismiss = { showRejectAll = false },
            onConfirm = { reason ->
                showRejectAll = false
                viewModel.rejectAll(assignmentId, reason)
            },
        )
    }
}

/** Pick a common rejection reason, or «أخرى» to type one. */
@Composable
private fun RejectionReasonDialog(
    title: String,
    message: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var selected by remember { mutableStateOf("") }
    var other by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                RECEIPT_REJECTION_REASONS.forEach { reason ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { selected = reason }
                            .padding(vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = if (selected == reason) "◉" else "○",
                            color = CortobaBrown,
                        )
                        Text(reason, modifier = Modifier.padding(start = 8.dp))
                    }
                }
                if (selected == "أخرى") {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = other,
                        onValueChange = { other = it },
                        label = { Text("اكتب سبب الرفض") },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val reason = if (selected == "أخرى") other.trim() else selected
                    if (reason.isNotBlank()) onConfirm(reason)
                },
            ) {
                Text("تأكيد", color = CortobaBrown)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("رجاء") }
        },
    )
}

/** Common rejection reasons, plus «أخرى» for a free-text reason. */
private val RECEIPT_REJECTION_REASONS = listOf(
    "تالف",
    "خطأ في الصنف",
    "كمية أقل",
    "متأخر عن الموعد",
    "مواصفات غير مطابقة",
    "أخرى",
)

/** Selected state of one item in the receiving form. */
private enum class ReceiptMode { FULL, PARTIAL, REJECT }

/**
 * A full / partial / reject action button with a visible selected state: the
 * active mode is filled, the others stay outlined, so a tap gives immediate
 * feedback instead of silently changing numbers elsewhere on the screen.
 */
@Composable
private fun RowScope.ReceiptModeButton(
    text: String,
    selected: Boolean,
    color: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    val padding = PaddingValues(horizontal = 4.dp)
    if (selected) {
        Button(
            onClick = onClick,
            shape = shape,
            colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Color.White),
            contentPadding = padding,
            modifier = Modifier.weight(1f),
        ) {
            Text(text, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
            contentPadding = padding,
            modifier = Modifier.weight(1f),
        ) {
            Text(text, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** One consolidated item in the receiving form with full / partial / reject. */
@Composable
private fun ReceiptGroupCard(
    group: ConsolidatedItem,
    entries: List<ReceiptEntry>,
    submitting: Boolean,
    onReceivedChange: (Int, String) -> Unit,
    onRejectedChange: (Int, String) -> Unit,
    onReasonChange: (Int, String) -> Unit,
    onReceiveFull: (Int) -> Unit,
    onReceivePartial: (Int) -> Unit,
    onReject: (Int) -> Unit,
) {
    var showPartial by remember { mutableStateOf(false) }
    var showDistribution by remember { mutableStateOf(false) }
    var rejectingPoItemId by remember { mutableStateOf<Int?>(null) }
    val entryByPoItemId = entries.associateBy { it.poItemId }

    CreamCard(modifier = Modifier.animateContentSize()) {
        Column {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = group.displayName,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    if (!group.partNo.isNullOrBlank()) {
                        Text(
                            text = "رقم القطعة: ${group.partNo}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "المطلوب",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "${formatQty(group.totalRemainingQty)} ${group.uom ?: ""}".trim(),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        color = CortobaBrown,
                    )
                }
            }

            if (group.totalAcceptedQty > 0) {
                Spacer(Modifier.height(6.dp))
                InfoRow("المستلم سابقاً", formatQty(group.totalAcceptedQty))
            }

            Spacer(Modifier.height(10.dp))

            // Each line carries its own buttons, and each tap records that line
            // on the server at once — there is no separate confirm step.
            entries.forEach { entry ->
                ReceiptLineActions(
                    entry = entry,
                    submitting = submitting,
                    expanded = showPartial,
                    onTogglePartial = { showPartial = !showPartial },
                    onReceivedChange = { onReceivedChange(entry.poItemId, it) },
                    onRejectedChange = { onRejectedChange(entry.poItemId, it) },
                    onReasonChange = { onReasonChange(entry.poItemId, it) },
                    onReceiveFull = { onReceiveFull(entry.poItemId) },
                    onReceivePartial = { onReceivePartial(entry.poItemId) },
                    onReject = { rejectingPoItemId = entry.poItemId },
                )
                Spacer(Modifier.height(10.dp))
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { showDistribution = !showDistribution }
                    .background(CortobaCream, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (showDistribution) {
                        "إخفاء التوزيع على أوامر الشراء"
                    } else {
                        "عرض التوزيع على أوامر الشراء"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = CortobaBrown,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (showDistribution) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null,
                    tint = CortobaBrown,
                )
            }

            if (showDistribution) {
                Spacer(Modifier.height(8.dp))
                group.allocations.forEach { allocation ->
                    AllocationRow(allocation)
                }
            }
        }
    }

    // A rejection needs a reason; picking one records the rejection at once.
    rejectingPoItemId?.let { poItemId ->
        RejectionReasonDialog(
            title = "رفض الصنف",
            message = "اختر سبب الرفض — سيتم تسجيله فوراً.",
            onDismiss = { rejectingPoItemId = null },
            onConfirm = { reason ->
                onReasonChange(poItemId, reason)
                rejectingPoItemId = null
                onReject(poItemId)
            },
        )
    }
}

/**
 * The per-line actions: «استلام كلي» records the whole quantity now, «استلام
 * جزئي» reveals the quantity fields and a «تنفيذ» that records them, «رفض»
 * opens the reason picker. No separate confirm step.
 */
@Composable
private fun ReceiptLineActions(
    entry: ReceiptEntry,
    submitting: Boolean,
    expanded: Boolean,
    onTogglePartial: () -> Unit,
    onReceivedChange: (String) -> Unit,
    onRejectedChange: (String) -> Unit,
    onReasonChange: (String) -> Unit,
    onReceiveFull: () -> Unit,
    onReceivePartial: () -> Unit,
    onReject: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            text = "أمر شراء ${entry.poNo}",
            style = MaterialTheme.typography.bodySmall,
            color = CortobaBrown,
        )
        Text(
            text = "المتبقي: ${formatQty(entry.requiredQty)}",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(6.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ReceiptActionButton(
                text = "استلام كلي",
                color = StatusGreen,
                enabled = !submitting,
                onClick = onReceiveFull,
            )
            ReceiptActionButton(
                text = "استلام جزئي",
                color = StatusBlue,
                enabled = !submitting,
                onClick = onTogglePartial,
            )
            ReceiptActionButton(
                text = "رفض",
                color = StatusAmber,
                enabled = !submitting,
                onClick = onReject,
            )
        }

        if (expanded) {
            Spacer(Modifier.height(8.dp))
            ReceiptLineInput(
                entry = entry,
                poNo = entry.poNo,
                onReceivedChange = onReceivedChange,
                onRejectedChange = onRejectedChange,
                onReasonChange = onReasonChange,
            )
            Spacer(Modifier.height(6.dp))
            BrandActionButton(
                text = "تنفيذ",
                enabled = !submitting,
                onClick = onReceivePartial,
            )
        }
    }
}

/** A compact per-line action button. */
@Composable
private fun RowScope.ReceiptActionButton(
    text: String,
    color: Color,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
        contentPadding = PaddingValues(horizontal = 4.dp),
        modifier = Modifier.weight(1f),
    ) {
        Text(text, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ReceiptLineInput(
    entry: ReceiptEntry,
    poNo: String,
    onReceivedChange: (String) -> Unit,
    onRejectedChange: (String) -> Unit,
    onReasonChange: (String) -> Unit,
) {
    val hasDamage = (entry.rejectedQty.toDoubleOrNull() ?: 0.0) > 0.0

    Column(Modifier.padding(vertical = 6.dp)) {
        Text(
            text = "أمر شراء $poNo",
            style = MaterialTheme.typography.bodySmall,
            color = CortobaBrown,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = entry.receivedQty,
                onValueChange = onReceivedChange,
                label = { Text("المستلم") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = entry.rejectedQty,
                onValueChange = onRejectedChange,
                label = { Text("تالف") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f),
            )
        }
        if (hasDamage) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = entry.rejectionReason,
                onValueChange = onReasonChange,
                label = { Text("سبب التلف") },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** `SPO-001 → P26E001 → 2 وحدة` — the traceability line, verbatim. */
@Composable
private fun AllocationRow(allocation: PickupAllocation) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = allocation.poNo,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = CortobaBrown,
            modifier = Modifier.width(84.dp),
        )
        Text(text = "←", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            text = allocation.customerPoNos.joinToString("، ").ifBlank { "غير مرتبط" },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f).padding(start = 8.dp),
        )
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = formatQty(allocation.remainingQty),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface,
            )
            if (allocation.acceptedQty > 0) {
                Text(
                    text = "تم استلام ${formatQty(allocation.acceptedQty)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
