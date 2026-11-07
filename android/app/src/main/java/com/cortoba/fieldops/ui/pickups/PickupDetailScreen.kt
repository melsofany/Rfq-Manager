package com.cortoba.fieldops.ui.pickups

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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

    var showSummary by remember { mutableStateOf(false) }
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

                form.result != null -> ReceiptResultView(
                    result = form.result!!,
                    onDone = onDone,
                )

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
                                    onReceivedChange = viewModel::onReceivedQtyChange,
                                    onRejectedChange = viewModel::onRejectedQtyChange,
                                    onReasonChange = viewModel::onRejectionReasonChange,
                                    onFull = { viewModel.fillGroupFullQuantity(group.groupKey) },
                                    onReject = { viewModel.rejectGroup(group.groupKey) },
                                )
                            }

                            item {
                                CreamCard {
                                    Column {
                                        Text(
                                            text = "ملاحظات عامة",
                                            style = MaterialTheme.typography.titleMedium,
                                            color = CortobaBrown,
                                        )
                                        OutlinedTextField(
                                            value = form.notes,
                                            onValueChange = viewModel::onNotesChange,
                                            placeholder = { Text("أي ملاحظات على عملية الاستلام") },
                                            shape = RoundedCornerShape(12.dp),
                                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                                        )
                                    }
                                }
                            }

                            if (form.error != null) {
                                item { ErrorBanner(form.error!!) }
                            }

                            item { ReceiptSummaryCard(summary) }

                            item {
                                BrandActionButton(
                                    text = "تأكيد الاستلام",
                                    enabled = !form.submitting,
                                    onClick = { showSummary = true },
                                )
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

    if (showSummary) {
        val summary = viewModel.summaryFor(form.entries)
        AlertDialog(
            onDismissRequest = { showSummary = false },
            title = { Text("تأكيد الاستلام") },
            text = {
                Column {
                    InfoRow("عدد الأصناف", "${summary.distinctItems}")
                    InfoRow("إجمالي المطلوب", formatQty(summary.totalRequired))
                    InfoRow("إجمالي المستلم", formatQty(summary.totalReceived), emphasize = true)
                    InfoRow("الكميات الناقصة", formatQty(summary.totalMissing))
                    InfoRow("الكميات التالفة", formatQty(summary.totalRejected))
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "سيتم تسجيل الكميات المقبولة فقط كمتاحة للتسليم للعملاء. " +
                            "لا يمكن التراجع عن هذه العملية.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showSummary = false
                        viewModel.submit(assignmentId)
                    },
                ) {
                    Text("تأكيد نهائي", color = CortobaBrown)
                }
            },
            dismissButton = {
                TextButton(onClick = { showSummary = false }) { Text("رجوع") }
            },
        )
    }

    if (showConfirmAll) {
        AlertDialog(
            onDismissRequest = { showConfirmAll = false },
            title = { Text("استلام الكل") },
            text = { Text("سيتم تعبئة كل الأصناف بالكمية المطلوبة كاملة. هل تريد المتابعة؟") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showConfirmAll = false
                        viewModel.fillAllFullQuantity()
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
        AlertDialog(
            onDismissRequest = { showRejectAll = false },
            title = { Text("رفض الكل") },
            text = { Text("سيتم وضع كل الأصناف كغير مستلمة (رفض). هل تريد المتابعة؟") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showRejectAll = false
                        viewModel.rejectAll()
                    },
                ) {
                    Text("رفض الكل", color = StatusAmber)
                }
            },
            dismissButton = {
                TextButton(onClick = { showRejectAll = false }) { Text("رجوع") }
            },
        )
    }
}

/** One consolidated item in the receiving form with full / partial / reject. */
@Composable
private fun ReceiptGroupCard(
    group: ConsolidatedItem,
    entries: List<ReceiptEntry>,
    onReceivedChange: (Int, String) -> Unit,
    onRejectedChange: (Int, String) -> Unit,
    onReasonChange: (Int, String) -> Unit,
    onFull: () -> Unit,
    onReject: () -> Unit,
) {
    var showPartial by remember { mutableStateOf(false) }
    var showDistribution by remember { mutableStateOf(false) }
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

            Spacer(Modifier.height(8.dp))

            InfoRow("المستلم سابقاً", formatQty(group.totalAcceptedQty))

            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = onFull,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("استلام كلي", color = StatusGreen)
                }
                OutlinedButton(
                    onClick = { showPartial = !showPartial },
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("استلام جزئي", color = StatusBlue)
                }
                OutlinedButton(
                    onClick = onReject,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("رفض", color = StatusAmber)
                }
            }

            if (showPartial) {
                Spacer(Modifier.height(8.dp))
                group.allocations.forEach { allocation ->
                    val entry = entryByPoItemId[allocation.poItemId]
                    if (entry != null) {
                        ReceiptLineInput(
                            entry = entry,
                            poNo = allocation.poNo,
                            onReceivedChange = { onReceivedChange(entry.poItemId, it) },
                            onRejectedChange = { onRejectedChange(entry.poItemId, it) },
                            onReasonChange = { onReasonChange(entry.poItemId, it) },
                        )
                    }
                }
            }

            Spacer(Modifier.height(6.dp))

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
}

/** Editable received/damaged quantities for one original PO line (partial receipt). */
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

@Composable
private fun ReceiptSummaryCard(summary: ReceiptSummary) {
    CreamCard {
        Column {
            Text(
                text = "ملخص الاستلام",
                style = MaterialTheme.typography.titleMedium,
                color = CortobaBrown,
            )
            InfoRow("عدد الأصناف", "${summary.distinctItems}")
            InfoRow("إجمالي المطلوب", formatQty(summary.totalRequired))
            InfoRow("إجمالي المستلم", formatQty(summary.totalReceived), emphasize = true)
            InfoRow("الكميات المقبولة", formatQty(summary.totalAccepted))
            InfoRow("الكميات التالفة", formatQty(summary.totalRejected))
            InfoRow("الكميات الناقصة", formatQty(summary.totalMissing))
        }
    }
}

/** The outcome screen: online, queued offline, or an already-applied duplicate. */
@Composable
private fun ReceiptResultView(result: ReceiptSubmitResult, onDone: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (result.queuedOffline) {
            Icon(Icons.Default.CloudOff, contentDescription = null, tint = StatusBlue, modifier = Modifier.height(64.dp))
            Text(
                text = "تم الحفظ محلياً",
                style = MaterialTheme.typography.headlineSmall,
                color = StatusBlue,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = "لا يوجد اتصال بالإنترنت. سيتم إرسال عملية الاستلام تلقائياً عند عودة الاتصال، " +
                    "ولن تُعتمد رسمياً إلا بعد تأكيد الخادم.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        } else {
            Icon(
                imageVector = Icons.Default.CloudDone,
                contentDescription = null,
                tint = if (result.partial) StatusAmber else StatusGreen,
                modifier = Modifier.height(64.dp),
            )
            Text(
                text = when {
                    result.duplicate -> "تمت معالجة هذه العملية مسبقاً"
                    result.partial -> "تم تسجيل استلام جزئي"
                    else -> "تم تأكيد الاستلام"
                },
                style = MaterialTheme.typography.headlineSmall,
                color = if (result.partial) StatusAmber else StatusGreen,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = if (result.partial) {
                    "تم تسجيل الكميات المقبولة، وتبقى الكميات الناقصة على نفس المهمة " +
                        "لإتمام استلامها في زيارة أخرى."
                } else {
                    "تم تسجيل الكميات المقبولة وأصبحت متاحة لتسليم العملاء."
                },
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        }

        Spacer(Modifier.height(20.dp))

        CreamCard {
            Column {
                InfoRow("الكميات المقبولة", formatQty(result.acceptedQty), emphasize = true)
                InfoRow("الكميات الناقصة", formatQty(result.missingQty))
            }
        }

        Spacer(Modifier.height(24.dp))

        Button(
            onClick = onDone,
            colors = ButtonDefaults.buttonColors(
                containerColor = CortobaBrown,
                contentColor = CortobaCream,
            ),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.CheckCircle, contentDescription = null)
                Text("تم", modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}
