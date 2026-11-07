package com.cortoba.fieldops.ui.pickups

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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.CloudDone
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.ui.components.BrandActionButton
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusBlue
import com.cortoba.fieldops.ui.theme.StatusGreen

/**
 * Receiving quantities, one row per ORIGINAL purchase-order line.
 *
 * The screen is honest about the difference between "full" and "partial": the
 * rep types what actually arrived, and the summary recomputes the missing
 * quantity live. Nothing is written locally as "done" — the server is the only
 * thing that can mark a receipt complete.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReceiptConfirmScreen(
    assignmentId: Int,
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: PickupViewModel = hiltViewModel(),
) {
    val detailState by viewModel.detail.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()

    LaunchedEffect(assignmentId) {
        // loadDetail seeds the form itself once the task has arrived. Calling a
        // separate prepareForm() here would read the still-empty detail state
        // and leave the screen with no rows to receive.
        viewModel.loadDetail(assignmentId)
    }

    var showSummary by remember { mutableStateOf(false) }

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
                                    Text(
                                        text = data.supplier?.name ?: "مورد غير محدد",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    InfoRow("أمر الشراء", data.po?.poNo)
                                    InfoRow("عدد الأصناف", "${summary.distinctItems}")
                                    InfoRow("إجمالي المطلوب", formatQty(summary.totalRequired))
                                }
                            }
                        }

                        item { SectionTitle("أدخل الكميات المستلمة") }

                        item {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                BrandActionButton(
                                    text = "استلام الكل",
                                    onClick = viewModel::fillAllFullQuantity,
                                    modifier = Modifier.weight(1f),
                                )
                                OutlineActionButton(
                                    text = "رفض الكل",
                                    onClick = viewModel::rejectAll,
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }

                        items(form.entries, key = { it.poItemId }) { entry ->
                            ReceiptEntryCard(
                                entry = entry,
                                onReceivedChange = { viewModel.onReceivedQtyChange(entry.poItemId, it) },
                                onRejectedChange = { viewModel.onRejectedQtyChange(entry.poItemId, it) },
                                onReasonChange = { viewModel.onRejectionReasonChange(entry.poItemId, it) },
                                onFull = { viewModel.fillFullQuantity(entry.poItemId) },
                                onNone = { viewModel.markNotReceived(entry.poItemId) },
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

                        item {
                            ReceiptSummaryCard(summary)
                        }

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
}

@Composable
private fun ReceiptEntryCard(
    entry: ReceiptEntry,
    onReceivedChange: (String) -> Unit,
    onRejectedChange: (String) -> Unit,
    onReasonChange: (String) -> Unit,
    onFull: () -> Unit,
    onNone: () -> Unit,
) {
    val received = entry.receivedQty.toDoubleOrNull() ?: 0.0
    val missing = (entry.requiredQty - received).coerceAtLeast(0.0)
    val hasDamage = (entry.rejectedQty.toDoubleOrNull() ?: 0.0) > 0.0

    CreamCard {
        Column {
            Text(
                text = entry.displayName,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            InfoRow("الكمية المطلوبة", formatQty(entry.requiredQty))

            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = entry.receivedQty,
                    onValueChange = onReceivedChange,
                    label = { Text("المستلم") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f),
                )
                OutlinedTextField(
                    value = entry.rejectedQty,
                    onValueChange = onRejectedChange,
                    label = { Text("تالف") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
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

            Spacer(Modifier.height(8.dp))

            InfoRow(
                label = "الكمية الناقصة",
                value = formatQty(missing),
                emphasize = missing > 0,
            )

            Spacer(Modifier.height(6.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = onFull,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("استلام كامل", color = CortobaBrown)
                }
                OutlinedButton(
                    onClick = onNone,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("لم يُستلم", color = StatusAmber)
                }
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
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
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
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
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
