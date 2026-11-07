package com.cortoba.fieldops.ui.deliveries

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
import androidx.compose.ui.text.style.TextAlign
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
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.SignaturePad
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusBlue
import com.cortoba.fieldops.ui.theme.StatusGreen

/**
 * Delivery quantities, recipient name, signature and evidence.
 *
 * The available quantity is the hard ceiling on every line: it is what the
 * supplier actually delivered and the customer's order accepted, so the rep can
 * never hand over goods that were never received.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeliveryConfirmScreen(
    assignmentId: Int,
    onBack: () -> Unit,
    onDone: () -> Unit,
    viewModel: DeliveryViewModel = hiltViewModel(),
) {
    val detailState by viewModel.detail.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()

    LaunchedEffect(assignmentId) {
        // loadDetail seeds the form itself once the task has arrived. Calling a
        // separate prepareForm() here would read the still-empty detail state
        // and leave the screen with no rows to deliver.
        viewModel.loadDetail(assignmentId)
    }

    var showSummary by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("التسليم", fontWeight = FontWeight.Bold) },
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

                form.result != null -> DeliveryResultView(result = form.result!!, onDone = onDone)

                else -> {
                    val data = detailState.data!!
                    val summary = viewModel.deliverySummary()

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
                                        text = data.customer?.name
                                            ?: data.customerPo?.customerName
                                            ?: "عميل غير محدد",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    InfoRow("أمر العميل", data.customerPo?.customerPoNo)
                                    InfoRow("عدد الأصناف", "${summary.distinctItems}")
                                    InfoRow("إجمالي المتاح", formatQty(summary.totalAvailable))
                                }
                            }
                        }

                        item { SectionTitle("أدخل الكميات المسلّمة") }

                        items(form.entries, key = { it.customerPoItemId }) { entry ->
                            DeliveryEntryCard(
                                entry = entry,
                                onDeliveredChange = {
                                    viewModel.onDeliveredQtyChange(entry.customerPoItemId, it)
                                },
                                onRejectedChange = {
                                    viewModel.onRejectedQtyChange(entry.customerPoItemId, it)
                                },
                                onReasonChange = {
                                    viewModel.onRejectionReasonChange(entry.customerPoItemId, it)
                                },
                                onFull = { viewModel.markFullQuantity(entry.customerPoItemId) },
                                onRejectAll = { viewModel.markRejected(entry.customerPoItemId) },
                            )
                        }

                        item {
                            CreamCard {
                                Column {
                                    Text(
                                        text = "بيانات المستلم",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = CortobaBrown,
                                    )
                                    OutlinedTextField(
                                        value = form.recipientName,
                                        onValueChange = viewModel::onRecipientNameChange,
                                        label = { Text("اسم المستلم") },
                                        singleLine = true,
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                                    )
                                    OutlinedTextField(
                                        value = form.notes,
                                        onValueChange = viewModel::onNotesChange,
                                        label = { Text("ملاحظات") },
                                        shape = RoundedCornerShape(12.dp),
                                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                                    )
                                }
                            }
                        }

                        item {
                            CreamCard {
                                SignaturePad(onSigned = viewModel::onSigned)
                            }
                        }

                        if (form.error != null) {
                            item { ErrorBanner(form.error!!) }
                        }

                        item { DeliverySummaryCard(summary) }

                        item {
                            BrandActionButton(
                                text = "تأكيد التسليم",
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
        val summary = viewModel.deliverySummary()
        AlertDialog(
            onDismissRequest = { showSummary = false },
            title = { Text("تأكيد التسليم") },
            text = {
                Column {
                    InfoRow("عدد الأصناف", "${summary.distinctItems}")
                    InfoRow("إجمالي المتاح", formatQty(summary.totalAvailable))
                    InfoRow("إجمالي المسلّم", formatQty(summary.totalDelivered), emphasize = true)
                    InfoRow("المرفوض من العميل", formatQty(summary.totalRejected))
                    InfoRow("المستلم", form.recipientName.ifBlank { "—" })
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "سيتم تسجيل العملية باسمك ووقتها. " +
                            "لا يمكن تعديل السجل بعد التأكيد.",
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
private fun DeliveryEntryCard(
    entry: DeliveryEntry,
    onDeliveredChange: (String) -> Unit,
    onRejectedChange: (String) -> Unit,
    onReasonChange: (String) -> Unit,
    onFull: () -> Unit,
    onRejectAll: () -> Unit,
) {
    val delivered = entry.deliveredQty.toDoubleOrNull() ?: 0.0
    val remaining = (entry.availableQty - delivered).coerceAtLeast(0.0)
    val hasRejection = (entry.rejectedQty.toDoubleOrNull() ?: 0.0) > 0.0

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

            Spacer(Modifier.height(8.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = entry.deliveredQty,
                    onValueChange = onDeliveredChange,
                    label = { Text("المسلّم") },
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
                    label = { Text("مرفوض") },
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Decimal,
                    ),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f),
                )
            }

            if (hasRejection) {
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = entry.rejectionReason,
                    onValueChange = onReasonChange,
                    label = { Text("سبب الرفض") },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(8.dp))

            InfoRow("المتبقي", formatQty(remaining), emphasize = remaining > 0)

            Spacer(Modifier.height(6.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = onFull,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("تسليم كامل", color = CortobaBrown)
                }
                OutlinedButton(
                    onClick = onRejectAll,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    Text("رفض", color = CortobaBrown)
                }
            }
        }
    }
}

@Composable
private fun DeliverySummaryCard(summary: DeliverySummary) {
    CreamCard {
        Column {
            Text(
                text = "ملخص التسليم",
                style = MaterialTheme.typography.titleMedium,
                color = CortobaBrown,
            )
            InfoRow("عدد الأصناف", "${summary.distinctItems}")
            InfoRow("إجمالي المتاح", formatQty(summary.totalAvailable))
            InfoRow("إجمالي المسلّم", formatQty(summary.totalDelivered), emphasize = true)
            InfoRow("المرفوض", formatQty(summary.totalRejected))
            InfoRow(
                "المتبقي للتسليم",
                formatQty((summary.totalAvailable - summary.totalDelivered).coerceAtLeast(0.0)),
            )
        }
    }
}

@Composable
private fun DeliveryResultView(result: DeliverySubmitResult, onDone: () -> Unit) {
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
                text = "لا يوجد اتصال بالإنترنت. سيتم إرسال عملية التسليم تلقائياً عند عودة الاتصال، " +
                    "ولن تُعتمد رسمياً إلا بعد تأكيد الخادم.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onBackground,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )
        } else {
            Icon(Icons.Default.CloudDone, contentDescription = null, tint = StatusGreen, modifier = Modifier.height(64.dp))
            Text(
                text = "تم تأكيد التسليم",
                style = MaterialTheme.typography.headlineSmall,
                color = StatusGreen,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 12.dp),
            )
            Text(
                text = "تم تسجيل الكميات المسلّمة باسمك ووقت التنفيذ.",
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
