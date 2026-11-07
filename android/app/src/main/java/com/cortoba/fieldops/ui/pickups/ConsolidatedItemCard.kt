package com.cortoba.fieldops.ui.pickups

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupAllocation
import com.cortoba.fieldops.core.util.formatQty
import com.cortoba.fieldops.ui.components.CreamCard
import com.cortoba.fieldops.ui.components.InfoRow
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCoral
import com.cortoba.fieldops.ui.theme.CortobaCream

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
