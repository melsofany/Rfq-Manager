package com.cortoba.fieldops.ui.deliveries

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudDone
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.network.dto.CustomerDeliveryPo
import com.cortoba.fieldops.core.util.formatDate
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.StatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusBlue
import com.cortoba.fieldops.ui.theme.StatusGreen

/**
 * One purchase order: its header, the order-level actions (full delivery /
 * full rejection), and each line as its own card with full / partial / reject.
 *
 *   العملاء ← كارت العميل ← كارت أمر الشراء ← بنود الأمر وإجراءاتها
 *
 * The screen loads the whole customer and picks the requested order, so it works
 * even when opened directly (deep link / process death) without the previous
 * screen having run.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PoDeliveryScreen(
    customerKey: String,
    customerPoId: Int,
    onBack: () -> Unit,
    viewModel: DeliveryViewModel = hiltViewModel(),
) {
    val state by viewModel.customerDetail.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()

    LaunchedEffect(customerKey) { viewModel.loadCustomerDetail(customerKey) }

    val po: CustomerDeliveryPo? = state.data?.purchaseOrders
        ?.firstOrNull { it.customerPoId == customerPoId }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = po?.let { "أمر ${it.customerPoNo}" } ?: "تفاصيل الأمر",
                        fontWeight = FontWeight.Bold,
                    )
                },
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
                state.loading && state.data == null -> LoadingBox(Modifier.fillMaxSize())

                form.result != null -> DeliveryResultView(
                    result = form.result!!,
                    onDone = {
                        // Return to the order list with the fresh state.
                        viewModel.clearResult()
                        onBack()
                    },
                )

                po == null -> Column(Modifier.padding(20.dp)) {
                    if (state.error != null) {
                        ErrorBanner(state.error!!)
                    } else {
                        CreamCard {
                            Text(
                                text = "هذا الأمر لم يعد تحت التسليم — تمت تسويته بالكامل.",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }

                else -> {
                    val entries = form.entries.filter { it.customerPoId == customerPoId }
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (state.fromCache) {
                            item { OfflineBanner(state.cachedAt) }
                        }

                        item { PoHeaderCard(po) }

                        item {
                            PoActionsRow(
                                onPoFull = { viewModel.markPoFull(customerPoId) },
                                onPoReject = { reason ->
                                    viewModel.markPoRejected(customerPoId, reason)
                                },
                            )
                        }

                        item { SectionTitle("بنود أمر الشراء") }

                        items(entries, key = { "line-${it.customerPoItemId}" }) { entry ->
                            DeliveryLineCard(
                                entry = entry,
                                onDeliveredChange = {
                                    viewModel.onDeliveredQtyChange(entry.customerPoItemId, it)
                                },
                                onReasonChange = { viewModel.setLineReason(entry.customerPoItemId, it) },
                                onFull = { viewModel.markLineFull(entry.customerPoItemId) },
                                onReject = { viewModel.markLineRejected(entry.customerPoItemId) },
                            )
                        }

                        if (form.error != null) {
                            item { ErrorBanner(form.error!!) }
                        }

                        item {
                            Button(
                                onClick = { viewModel.submitPo(customerPoId, customerKey) },
                                enabled = !form.submitting,
                                shape = RoundedCornerShape(12.dp),
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = CortobaBrown,
                                    contentColor = CortobaCream,
                                ),
                                modifier = Modifier.fillMaxWidth().height(52.dp),
                            ) {
                                Text(
                                    "تأكيد تسليم الأمر",
                                    style = MaterialTheme.typography.titleMedium,
                                )
                            }
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
                    }
                }
            }
        }
    }
}

/** The order header: number, date, buyer, item count and total value. */
@Composable
private fun PoHeaderCard(po: CustomerDeliveryPo) {
    CreamCard {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "أمر العميل ${po.customerPoNo}",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                StatusChip(po.status)
            }
            Spacer(Modifier.height(8.dp))
            InfoRow("تاريخ الأمر", formatDate(po.poDate))
            InfoRow("المشتري", po.buyerName)
            InfoRow("إجمالي الأصناف", "${po.totalItems}")
            InfoRow("إجمالي القيمة", formatQty(po.totalAmount), emphasize = true)
            if (!po.notes.isNullOrBlank()) {
                InfoRow("ملاحظات", po.notes)
            }
        }
    }
}

@Composable
private fun PoActionsRow(onPoFull: () -> Unit, onPoReject: (String) -> Unit) {
    var showPoReject by remember { mutableStateOf(false) }

    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(
            onClick = onPoFull,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.weight(1f),
        ) {
            Text("تسليم كلي", color = StatusGreen)
        }
        OutlinedButton(
            onClick = { showPoReject = true },
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.weight(1f),
        ) {
            Text("رفض كلي", color = StatusAmber)
        }
    }

    if (showPoReject) {
        RejectionReasonDialog(
            title = "رفض كلي للأمر",
            onDismiss = { showPoReject = false },
            onConfirm = { reason ->
                showPoReject = false
                onPoReject(reason)
            },
        )
    }
}

/** One PO line: full / partial / reject, with the reason selector for rejections. */
@Composable
private fun DeliveryLineCard(
    entry: DeliveryEntry,
    onDeliveredChange: (String) -> Unit,
    onReasonChange: (String) -> Unit,
    onFull: () -> Unit,
    onReject: () -> Unit,
) {
    val delivered = entry.deliveredQty.toDoubleOrNull() ?: 0.0
    val remaining = (entry.availableQty - delivered).coerceAtLeast(0.0)
    var showReasonMenu by remember { mutableStateOf(false) }

    CreamCard {
        Column {
            Text(
                text = entry.displayName,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            InfoRow("المطلوب", formatQty(entry.orderedQty))
            InfoRow("المتاح للتسليم", formatQty(entry.availableQty), emphasize = true)
            if (entry.alreadyDeliveredQty > 0) {
                InfoRow("سُلّم سابقاً", formatQty(entry.alreadyDeliveredQty))
            }
            if (entry.alreadyRejectedQty > 0) {
                InfoRow("مرفوض سابقاً", formatQty(entry.alreadyRejectedQty))
            }

            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ModeButton(
                    text = "كلي",
                    selected = entry.mode == DeliveryLineMode.FULL,
                    color = StatusGreen,
                    onClick = onFull,
                )
                ModeButton(
                    text = "جزئي",
                    selected = entry.mode == DeliveryLineMode.PARTIAL,
                    color = StatusBlue,
                    onClick = { onDeliveredChange("") },
                )
                ModeButton(
                    text = "رفض",
                    selected = entry.mode == DeliveryLineMode.REJECT,
                    color = StatusAmber,
                    onClick = onReject,
                )
            }

            Spacer(Modifier.height(8.dp))

            OutlinedTextField(
                value = entry.deliveredQty,
                onValueChange = onDeliveredChange,
                label = { Text("الكمية المسلّمة") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            )

            InfoRow("المتبقي", formatQty(remaining), emphasize = remaining > 0)

            if (entry.mode == DeliveryLineMode.REJECT) {
                Spacer(Modifier.height(6.dp))
                Box {
                    OutlinedButton(
                        onClick = { showReasonMenu = true },
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = entry.rejectionReason.ifBlank { "اختر سبب الرفض" },
                            color = StatusAmber,
                        )
                    }
                    DropdownMenu(
                        expanded = showReasonMenu,
                        onDismissRequest = { showReasonMenu = false },
                    ) {
                        DELIVERY_REJECTION_REASONS.forEach { reason ->
                            DropdownMenuItem(
                                text = { Text(reason) },
                                onClick = {
                                    showReasonMenu = false
                                    // «أخرى» clears the field so the rep types a reason;
                                    // the common reasons are recorded as-is.
                                    onReasonChange(if (reason == "أخرى") "" else reason)
                                },
                            )
                        }
                    }
                }
                if (entry.rejectionReason.isBlank()) {
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = entry.rejectionReason,
                        onValueChange = onReasonChange,
                        label = { Text("اكتب سبب الرفض") },
                        singleLine = true,
                        shape = RoundedCornerShape(12.dp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun RowScope.ModeButton(
    text: String,
    selected: Boolean,
    color: Color,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(10.dp)
    if (selected) {
        Button(
            onClick = onClick,
            shape = shape,
            colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Color.White),
            contentPadding = PaddingValues(horizontal = 4.dp),
            modifier = Modifier.weight(1f),
        ) {
            Text(text, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
        }
    } else {
        OutlinedButton(
            onClick = onClick,
            shape = shape,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
            contentPadding = PaddingValues(horizontal = 4.dp),
            modifier = Modifier.weight(1f),
        ) {
            Text(text, maxLines = 1, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/** Pick a common rejection reason, or «أخرى» to type one. */
@Composable
private fun RejectionReasonDialog(
    title: String,
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
                DELIVERY_REJECTION_REASONS.forEach { reason ->
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
            TextButton(onClick = onDismiss) { Text("إلغاء") }
        },
    )
}

@Composable
private fun DeliveryResultView(result: DeliverySubmitResult, onDone: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (result.queuedOffline) {
            Icon(
                Icons.Default.CloudOff,
                contentDescription = null,
                tint = StatusBlue,
                modifier = Modifier.height(64.dp),
            )
            Text(
                text = "تم الحفظ محلياً",
                style = MaterialTheme.typography.headlineSmall,
                color = StatusBlue,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = "لا يوجد اتصال بالإنترنت. سيتم إرسال عملية التسليم تلقائياً عند عودة الاتصال، " +
                    "ولن تُعتمد رسمياً إلا بعد تأكيد الخادم.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        } else {
            Icon(
                Icons.Default.CloudDone,
                contentDescription = null,
                tint = StatusGreen,
                modifier = Modifier.height(64.dp),
            )
            Text(
                text = "تم تأكيد التسليم",
                style = MaterialTheme.typography.headlineSmall,
                color = StatusGreen,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = "تم تسجيل الكميات المسلّمة وأسباب الرفض باسمك ووقت التنفيذ.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        }

        Spacer(Modifier.height(20.dp))

        CreamCard {
            Column {
                InfoRow("إجمالي المسلّم", formatQty(result.deliveredQty), emphasize = true)
                InfoRow("المتبقي", formatQty(result.remainingQty))
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
