package com.cortoba.fieldops.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.cortoba.fieldops.R
import com.cortoba.fieldops.ui.theme.CortobaBrown
import com.cortoba.fieldops.ui.theme.CortobaCoral
import com.cortoba.fieldops.ui.theme.CortobaCream
import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusBlue
import com.cortoba.fieldops.ui.theme.StatusGreen
import com.cortoba.fieldops.ui.theme.StatusGrey
import com.cortoba.fieldops.ui.theme.StatusRed

/** Full-screen loading, used while a list or a detail is first fetched. */
@Composable
fun LoadingBox(modifier: Modifier = Modifier, message: String = "جاري التحميل...") {
    Column(
        modifier = modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
        Text(
            text = message,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.padding(top = 16.dp),
        )
    }
}

@Composable
fun EmptyState(
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            imageVector = Icons.Default.Info,
            contentDescription = null,
            tint = StatusGrey,
            modifier = Modifier.size(48.dp),
        )
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onBackground,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 12.dp),
        )
        if (subtitle != null) {
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = StatusGrey,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

/** A failure the representative can act on: the server's own wording. */
@Composable
fun ErrorBanner(message: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth().animateContentSize(),
        color = StatusRed.copy(alpha = 0.12f),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.ErrorOutline, contentDescription = null, tint = StatusRed)
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = StatusRed,
                modifier = Modifier.padding(start = 10.dp),
            )
        }
    }
}

/**
 * Stale-data banner. Shown whenever the screen renders a cached payload, so the
 * operator is never misled into thinking the numbers are live.
 */
@Composable
fun OfflineBanner(cachedAt: Long?, modifier: Modifier = Modifier) {
    val whenText = cachedAt?.let { com.cortoba.fieldops.core.util.relativeTime(it) } ?: ""
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = CortobaCoral.copy(alpha = 0.22f),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Sync, contentDescription = null, tint = MaterialTheme.colorScheme.onBackground)
            Text(
                text = if (whenText.isBlank()) {
                    "لا يوجد اتصال — يتم عرض نسخة محفوظة"
                } else {
                    "لا يوجد اتصال — نسخة محفوظة $whenText"
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

/**
 * Status chip. One mapping from server status code to Arabic label + colour, so
 * the same status never renders two different ways on two screens.
 */
@Composable
fun StatusChip(status: String, modifier: Modifier = Modifier) {
    val (label, color) = statusPresentation(status)
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = color,
        )
    }
}

/** Settlement state for the supplier card — labels only, never amounts. */
fun paymentStatusPresentation(status: String): Pair<String, Color> = when (status) {
    "paid" -> "مسدد" to StatusGreen
    "partial" -> "سداد جزئي" to StatusAmber
    "unpaid" -> "غير مسدد" to StatusRed
    else -> status to StatusGrey
}

@Composable
fun PaymentStatusChip(status: String, modifier: Modifier = Modifier) {
    val (label, color) = paymentStatusPresentation(status)
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = color)
    }
}

@Composable
fun SyncStatusChip(status: String, modifier: Modifier = Modifier) {
    val (label, color) = when (status) {
        "SAVED_LOCALLY" -> "محفوظ محلياً" to StatusBlue
        "PENDING" -> "في انتظار المزامنة" to StatusAmber
        "SYNCED" -> "تمت المزامنة" to StatusGreen
        "FAILED" -> "فشلت المزامنة" to StatusRed
        else -> status to StatusGrey
    }
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = color)
    }
}

/** A labelled key/value row — the workhorse of the detail screens. */
@Composable
fun InfoRow(
    label: String,
    value: String?,
    modifier: Modifier = Modifier,
    emphasize: Boolean = false,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = StatusGrey,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value?.takeIf { it.isNotBlank() } ?: "—",
            style = if (emphasize) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1.4f),
        )
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp),
    )
}

@Composable
fun CreamCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 1.dp,
    ) {
        Box(modifier = Modifier.padding(16.dp)) { content() }
    }
}

/** Shared colour/name mapping for both receipt and delivery status codes. */
fun statusPresentation(status: String): Pair<String, Color> = when (status.uppercase()) {
    "ASSIGNED" -> "تم الإسناد" to StatusBlue
    "SENT" -> "تم الإسناد" to StatusBlue
    "IN_PROGRESS" -> "جاري التنفيذ" to StatusAmber
    "PARTIALLY_RECEIVED" -> "استلام جزئي" to StatusAmber
    "RECEIVED" -> "تم الاستلام" to StatusGreen
    "PENDING" -> "في انتظار التسليم" to StatusBlue
    "IN_TRANSIT" -> "جاري التسليم" to StatusAmber
    "PARTIALLY_DELIVERED" -> "تسليم جزئي" to StatusAmber
    "DELIVERED" -> "تم التسليم" to StatusGreen
    "REJECTED" -> "مرفوض" to StatusRed
    "EXCEPTION" -> "توجد مشكلة" to StatusRed
    "CANCELLED" -> "ملغي" to StatusGrey
    "FULFILLED" -> "مكتمل" to StatusGreen
    else -> status to StatusGrey
}

@Composable
fun BrandHeader(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(CortobaCream)
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall, color = MaterialTheme.colorScheme.primary)
        if (subtitle != null) {
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground)
        }
    }
}

/** The primary call to action on a card — brand-coloured and touch-friendly. */
@Composable
fun BrandActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = CortobaBrown,
            contentColor = CortobaCream,
        ),
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
    ) {
        Text(text, style = MaterialTheme.typography.titleMedium)
    }
}

/** A secondary, outlined action (call, map, details). */
@Composable
fun OutlineActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
) {
    OutlinedButton(
        onClick = onClick,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = CortobaBrown),
        modifier = modifier.heightIn(min = 48.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.bodyLarge)
    }
}

/**
 * The Cortoba brand lockup — the traced mark and wordmark, rendered from the
 * bundled vector so it stays crisp at any size.
 */
@Composable
fun CortobaLogo(
    modifier: Modifier = Modifier,
) {
    Image(
        painter = painterResource(R.drawable.ic_cortoba_logo),
        contentDescription = "قرطبة للتوريدات",
        contentScale = ContentScale.Fit,
        modifier = modifier,
    )
}

/** The mark alone, for tight spaces such as an app bar or a list avatar. */
@Composable
fun CortobaMark(
    modifier: Modifier = Modifier,
) {
    Image(
        painter = painterResource(R.drawable.ic_cortoba_mark),
        contentDescription = "قرطبة للتوريدات",
        contentScale = ContentScale.Fit,
        modifier = modifier,
    )
}
