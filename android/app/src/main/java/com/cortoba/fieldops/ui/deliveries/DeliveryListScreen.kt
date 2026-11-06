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
import androidx.compose.material.icons.filled.Refresh
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
import com.cortoba.fieldops.ui.components.EmptyState
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.OutlineActionButton
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.StatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream

/**
 * Customer deliveries assigned to the representative.
 *
 * Only quantities that were actually RECEIVED AND ACCEPTED from the supplier are
 * available here — that is why a task can appear with fewer units than the
 * customer ordered. The card states the available quantity explicitly so the rep
 * never promises the customer more than exists.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeliveryListScreen(
    onBack: () -> Unit,
    onOpen: (Int) -> Unit,
    viewModel: DeliveryViewModel = hiltViewModel(),
) {
    val state by viewModel.list.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(Unit) { viewModel.loadList() }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("التسليمات", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "رجوع")
                    }
                },
                actions = {
                    IconButton(onClick = viewModel::loadList) {
                        Icon(Icons.Default.Refresh, contentDescription = "تحديث")
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
            when {
                state.loading && state.data == null -> LoadingBox(Modifier.fillMaxSize())

                state.data == null -> Column(Modifier.padding(20.dp)) {
                    if (state.error != null) ErrorBanner(state.error!!)
                }

                else -> {
                    val data = state.data!!
                    LazyColumn(
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
                                    Text(
                                        text = "ملخص التسليمات",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = CortobaBrown,
                                    )
                                    InfoRow("عدد مهام التسليم", "${data.summary.taskCount}")
                                    InfoRow("عدد الأصناف", "${data.summary.distinctItems}")
                                    InfoRow(
                                        "إجمالي الكميات المتاحة",
                                        formatQty(data.summary.availableQty),
                                        emphasize = true,
                                    )
                                }
                            }
                        }

                        if (data.tasks.isEmpty()) {
                            item {
                                EmptyState(
                                    title = "لا توجد تسليمات مسندة إليك",
                                    subtitle = "تصبح الكميات متاحة للتسليم بعد تأكيد استلامها من المورد",
                                )
                            }
                        } else {
                            item { SectionTitle("مهام التسليم") }
                        }

                        items(data.tasks, key = { "delivery-${it.assignmentId}" }) { task ->
                            CreamCard {
                                Column {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                text = task.customerName ?: "عميل غير محدد",
                                                style = MaterialTheme.typography.titleLarge,
                                                fontWeight = FontWeight.Bold,
                                            )
                                            Text(
                                                text = "أمر العميل: ${task.customerPoNo}",
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                        StatusChip(task.status)
                                    }

                                    Spacer(Modifier.height(10.dp))

                                    InfoRow("عدد الأصناف", "${task.distinctItemCount}")
                                    InfoRow("الكميات المتاحة", formatQty(task.availableQty))
                                    InfoRow("تاريخ الأمر", com.cortoba.fieldops.core.util.formatDate(task.poDate))

                                    Spacer(Modifier.height(10.dp))

                                    BrandActionButton(
                                        text = "عرض تفاصيل التسليم",
                                        onClick = { onOpen(task.assignmentId) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
