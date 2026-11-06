package com.cortoba.fieldops.ui.pickups

import androidx.compose.animation.animateContentSize
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupAllocation
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
import com.cortoba.fieldops.ui.theme.CortobaCoral
import com.cortoba.fieldops.ui.theme.CortobaCream

/**
 * All supplier pickups assigned to the signed-in representative.
 *
 * Two views, because they answer two different questions:
 *  • «أوامر الشراء» — one card per supplier PO: where do I go, and to whom.
 *  • «الأصناف الموحّدة» — the same product across several POs collapsed into one
 *    line with its total, expandable to the original PO allocation. This is the
 *    consolidation requirement: the rep reads 6 units once, and can still prove
 *    it is 2 + 3 + 1 against three different customer orders.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickupListScreen(
    onBack: () -> Unit,
    onOpen: (Int) -> Unit,
    viewModel: PickupViewModel = hiltViewModel(),
) {
    val state by viewModel.list.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(Unit) { viewModel.loadList() }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("الاستلامات", fontWeight = FontWeight.Bold) },
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
        Box(modifier = Modifier.fillMaxSize().padding(padding).systemBarsPadding()) {
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
                                        text = "ملخص الاستلامات",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = CortobaBrown,
                                    )
                                    InfoRow("عدد أوامر الشراء", "${data.summary.taskCount}")
                                    InfoRow("عدد الأصناف (موحّدة)", "${data.summary.distinctItems}")
                                    InfoRow(
                                        "إجمالي الكميات المتبقية",
                                        formatQty(data.summary.totalRemainingQty),
                                        emphasize = true,
                                    )
                                }
                            }
                        }

                        if (data.tasks.isEmpty()) {
                            item {
                                EmptyState(
                                    title = "لا توجد استلامات مسندة إليك",
                                    subtitle = "سيظهر هنا أي أمر شراء يتم إسناده لك من إدارة الموارد البشرية",
                                )
                            }
                        }

                        if (data.tasks.isNotEmpty()) {
                            item { SectionTitle("أوامر الشراء المطلوب استلامها") }
                        }

                        items(data.tasks, key = { "task-${it.poId}" }) { task ->
                            CreamCard {
                                Column {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(Modifier.weight(1f)) {
                                            Text(
                                                text = task.supplier?.name ?: "مورد غير محدد",
                                                style = MaterialTheme.typography.titleLarge,
                                                fontWeight = FontWeight.Bold,
                                                color = MaterialTheme.colorScheme.onSurface,
                                            )
                                            Text(
                                                text = "أمر شراء: ${task.poNo}",
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                        StatusChip(task.status)
                                    }

                                    Spacer(Modifier.height(10.dp))

                                    InfoRow("عدد الأصناف", "${task.distinctItemCount}")
                                    InfoRow("إجمالي الكميات", formatQty(task.totalRequiredQty))
                                    InfoRow("هاتف المورد", task.supplier?.phone)
                                    InfoRow("العنوان", task.supplier?.address)

                                    Spacer(Modifier.height(10.dp))

                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        OutlineActionButton(
                                            text = "الاتصال بالمورد",
                                            icon = Icons.Default.Call,
                                            onClick = { dialPhone(context, task.supplier?.phone) },
                                            modifier = Modifier.weight(1f),
                                        )
                                        OutlineActionButton(
                                            text = "الموقع",
                                            icon = Icons.Default.LocationOn,
                                            onClick = { openMap(context, task.supplier?.address) },
                                            modifier = Modifier.weight(1f),
                                        )
                                    }

                                    Spacer(Modifier.height(8.dp))

                                    BrandActionButton(
                                        text = "عرض الأصناف والاستلام",
                                        onClick = { onOpen(task.assignmentId ?: task.poId) },
                                    )
                                }
                            }
                        }

                        if (data.consolidatedItems.isNotEmpty()) {
                            item { SectionTitle("الأصناف الموحّدة (مجمّعة من كل أوامر الشراء)") }
                            items(data.consolidatedItems, key = { "grp-${it.groupKey}" }) { group ->
                                ConsolidatedItemCard(group)
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One consolidated product. The header shows the TOTAL the rep must collect; the
 * expansion shows every original supplier PO → customer PO → quantity, which is
 * what keeps the grouping traceable rather than merely convenient.
 */
@Composable
fun ConsolidatedItemCard(group: ConsolidatedItem, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }

    CreamCard(modifier = modifier.animateContentSize()) {
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
                    if (group.allocations.size > 1) {
                        Text(
                            text = "مجمّع من ${group.allocations.size} أوامر شراء",
                            style = MaterialTheme.typography.bodyMedium,
                            color = CortobaCoral,
                        )
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "الإجمالي المطلوب",
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
            if (group.customerPoNos.isNotEmpty()) {
                InfoRow("أوامر العملاء المرتبطة", group.customerPoNos.joinToString("، "))
            }

            Spacer(Modifier.height(6.dp))

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(CortobaCream, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (expanded) {
                        "إخفاء التوزيع على أوامر الشراء"
                    } else {
                        "عرض التوزيع على أوامر الشراء"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                    color = CortobaBrown,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = null,
                    tint = CortobaBrown,
                )
            }

            if (expanded) {
                Spacer(Modifier.height(8.dp))
                group.allocations.forEach { allocation ->
                    AllocationRow(allocation)
                }
            }
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
