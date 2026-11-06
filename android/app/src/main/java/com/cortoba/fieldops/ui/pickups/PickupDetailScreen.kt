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

/**
 * Supplier details + consolidated items for one pickup task.
 *
 * The action bar is the rep's field toolkit: call the supplier, open the
 * location, then start receiving.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PickupDetailScreen(
    assignmentId: Int,
    onBack: () -> Unit,
    onConfirm: (Int) -> Unit,
    viewModel: PickupViewModel = hiltViewModel(),
) {
    val state by viewModel.detail.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(assignmentId) { viewModel.loadDetail(assignmentId) }

    Scaffold(
        containerColor = CortobaCream,
        topBar = {
            TopAppBar(
                title = { Text("تفاصيل الاستلام", fontWeight = FontWeight.Bold) },
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
                                        text = data.supplier?.name ?: "مورد غير محدد",
                                        style = MaterialTheme.typography.titleLarge,
                                        fontWeight = FontWeight.Bold,
                                        modifier = Modifier.weight(1f),
                                    )
                                    StatusChip(data.status)
                                }
                                Spacer(Modifier.height(8.dp))
                                InfoRow("أمر الشراء", data.po?.poNo)
                                InfoRow("تاريخ الأمر", com.cortoba.fieldops.core.util.formatDate(data.po?.poDate))
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

                    item { SectionTitle("الأصناف المطلوبة (موحّدة)") }

                    items(data.items, key = { it.groupKey }) { group ->
                        ConsolidatedItemCard(group)
                    }

                    if (data.items.isNotEmpty()) {
                        item {
                            BrandActionButton(
                                text = "بدء الاستلام",
                                onClick = { onConfirm(data.assignmentId) },
                            )
                        }
                    }
                }
            }
        }
    }
}
