package com.cortoba.fieldops.ui.deliveries

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.network.dto.CustomerDeliveryDetailResponse
import com.cortoba.fieldops.core.util.dialPhone
import com.cortoba.fieldops.core.util.openMap
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream

/**
 * One customer and their purchase orders.
 *
 * The orders are shown as square cards — the same shape as the customer tiles on
 * the previous screen — so the rep drills down the same way at every level:
 *
 *   العملاء ← كارت العميل ← كارت أمر الشراء ← بنود الأمر وإجراءاتها
 *
 * Only orders that still have something to settle appear here; a completed order
 * is found in the delivery history.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomerDeliveryDetailScreen(
    customerKey: String,
    onBack: () -> Unit,
    onOpenPo: (Int) -> Unit,
    viewModel: DeliveryViewModel = hiltViewModel(),
) {
    val state by viewModel.customerDetail.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(customerKey) { viewModel.loadCustomerDetail(customerKey) }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("أوامر العميل", fontWeight = FontWeight.Bold) },
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

                else -> LazyVerticalGrid(
                    columns = GridCells.Fixed(2),
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (state.fromCache) {
                        item(span = { GridItemSpan(maxLineSpan) }) { OfflineBanner(state.cachedAt) }
                    }

                    item(span = { GridItemSpan(maxLineSpan) }) { CustomerHeaderCard(data, context) }

                    if (data.purchaseOrders.isEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            CreamCard {
                                Text(
                                    text = "لا توجد أوامر شراء تحت التسليم لهذا العميل. " +
                                        "تجد العمليات المكتملة في سجل التسليمات.",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    } else {
                        item(span = { GridItemSpan(maxLineSpan) }) { SectionTitle("أوامر الشراء") }
                    }

                    items(data.purchaseOrders, key = { "po-${it.customerPoId}" }) { po ->
                        PoSquare(
                            po = po,
                            onClick = { po.assignmentId?.let(onOpenPo) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun CustomerHeaderCard(
    data: CustomerDeliveryDetailResponse,
    context: android.content.Context,
) {
    CreamCard {
        Column {
            Text(
                text = data.customer?.name ?: "عميل غير محدد",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            InfoRow("جهة الاتصال", data.customer?.contactPerson)
            InfoRow("هاتف العميل", data.customer?.phone)
            InfoRow("عنوان التسليم", data.customer?.address)
            InfoRow("أوامر قيد التسليم", "${data.purchaseOrders.size}")
            InfoRow("المسؤول", data.representativeName)

            Spacer(Modifier.height(10.dp))

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
    }
}
