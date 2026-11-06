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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.util.dialPhone
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.core.util.openMap
import com.cortoba.fieldops.ui.components.BrandActionButton
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.StatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusGreen

/** Customer details and the quantities actually available for delivery. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeliveryDetailScreen(
    assignmentId: Int,
    onBack: () -> Unit,
    onConfirm: (Int) -> Unit,
    viewModel: DeliveryViewModel = hiltViewModel(),
) {
    val state by viewModel.detail.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(assignmentId) { viewModel.loadDetail(assignmentId) }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("تفاصيل التسليم", fontWeight = FontWeight.Bold) },
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
            val data = state.data
            when {
                state.loading && data == null -> LoadingBox(Modifier.fillMaxSize())

                data == null -> Column(Modifier.padding(20.dp)) {
                    if (state.error != null) ErrorBanner(state.error!!)
                }

                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (state.fromCache) {
                        item { OfflineBanner(state.cachedAt) }
                    }

                    item {
                        CreamCard {
                            Column {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        text = data.customer?.name ?: data.customerPo?.customerName
                                            ?: "عميل غير محدد",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.weight(1f),
                                    )
                                    StatusChip(data.status)
                                }
                                Spacer(Modifier.height(8.dp))
                                InfoRow("أمر العميل", data.customerPo?.customerPoNo)
                                InfoRow("تاريخ الأمر", com.cortoba.fieldops.core.util.formatDate(data.customerPo?.poDate))
                                InfoRow("جهة الاتصال", data.customer?.contactPerson)
                                InfoRow("هاتف العميل", data.customer?.phone)
                                InfoRow("عنوان التسليم", data.customer?.address)
                                if (!data.customerPo?.notes.isNullOrBlank()) {
                                    InfoRow("ملاحظات", data.customerPo?.notes)
                                }
                                InfoRow("المسؤول", data.representativeName)
                            }
                        }
                    }

                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlineActionButton(
                                text = "الاتصال بالعميل",
                                icon = Icons.Default.Call,
                                onClick = { dialPhone(context, data.customer?.phone) },
                                modifier = Modifier.weight(1f),
                            )
                            OutlineActionButton(
                                text = "فتح الموقع",
                                icon = Icons.Default.LocationOn,
                                onClick = { openMap(context, data.customer?.address) },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }

                    item { SectionTitle("أصناف التسليم") }

                    items(data.items, key = { it.customerPoItemId }) { item ->
                        CreamCard {
                            Column {
                                Text(
                                    text = item.description,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                )
                                if (!item.partNo.isNullOrBlank()) {
                                    Text(
                                        text = "رقم القطعة: ${item.partNo}",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                                InfoRow("الكمية المطلوبة", formatQty(item.orderedQty))
                                InfoRow(
                                    "المستلم من المورد",
                                    item.acceptedFromSupplierQty?.let { formatQty(it) } ?: "—",
                                )
                                InfoRow("تم تسليمه سابقاً", formatQty(item.deliveredQty))
                                InfoRow(
                                    "المتاح للتسليم",
                                    formatQty(item.availableQty),
                                    emphasize = true,
                                )
                            }
                        }
                    }

                    if (data.items.any { it.availableQty > 0 }) {
                        item {
                            BrandActionButton(
                                text = "بدء التسليم",
                                onClick = { onConfirm(data.assignmentId) },
                            )
                        }
                    } else {
                        item {
                            CreamCard {
                                Text(
                                    text = "لا توجد كميات متاحة للتسليم حالياً. " +
                                        "تصبح الكميات متاحة بعد تأكيد استلامها من المورد.",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = StatusGreen,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
