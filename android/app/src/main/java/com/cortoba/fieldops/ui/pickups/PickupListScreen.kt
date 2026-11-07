package com.cortoba.fieldops.ui.pickups

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cortoba.fieldops.core.network.dto.PickupTask
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.EmptyState
import com.cortoba.fieldops.ui.components.ErrorBanner
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.components.LoadingBox
import com.cortoba.fieldops.ui.components.OfflineBanner
import com.cortoba.fieldops.ui.components.SectionTitle
import com.cortoba.fieldops.ui.components.StatusChip
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCream

/**
 * All supplier pickups assigned to the signed-in representative.
 *
 * The list is a grid of supplier squares — one tap answers «where do I go and to
 * whom». The detail screen carries the items, payment state and receiving form.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickupListScreen(
    onBack: () -> Unit,
    onOpen: (Int) -> Unit,
    viewModel: PickupViewModel = hiltViewModel(),
) {
    val state by viewModel.list.collectAsStateWithLifecycle()

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
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(2),
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (state.fromCache) {
                            item(span = { GridItemSpan(maxLineSpan) }) { OfflineBanner(state.cachedAt) }
                        }

                        item(span = { GridItemSpan(maxLineSpan) }) {
                            CreamCard {
                                Column {
                                    Text(
                                        text = "ملخص الاستلامات",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = CortobaBrown,
                                    )
                                    InfoRow("عدد أوامر الشراء", "${data.summary.taskCount}")
                                    InfoRow("عدد الأصناف", "${data.summary.distinctItems}")
                                    InfoRow(
                                        "إجمالي الكميات المتبقية",
                                        formatQty(data.summary.totalRemainingQty),
                                        emphasize = true,
                                    )
                                }
                            }
                        }

                        if (data.tasks.isEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                EmptyState(
                                    title = "لا توجد استلامات مسندة إليك",
                                    subtitle = "سيظهر هنا أي أمر شراء يتم إسناده لك من إدارة الموارد البشرية",
                                )
                            }
                        }

                        if (data.tasks.isNotEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) { SectionTitle("الموردون") }
                        }

                        items(data.tasks, key = { "task-${it.poId}-${it.supplier?.id ?: "nosup"}" }) { task ->
                            SupplierSquare(
                                task = task,
                                onClick = { onOpen(task.assignmentId ?: task.poId) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** A compact supplier tile. The details (items, payment, receiving) live on the detail screen. */
@Composable
fun SupplierSquare(task: PickupTask, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier
            .aspectRatio(1f)
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 1.dp,
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = task.supplier?.name ?: "مورد غير محدد",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = "أمر شراء ${task.poNo}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(8.dp))
            StatusChip(task.status)
        }
    }
}
