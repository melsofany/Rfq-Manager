package com.cortoba.fieldops.core.util

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri

/**
 * Intents that hand off to the dialer and to Maps. Deliberately explicit about
 * "no app found" instead of letting the platform throw an ActivityNotFoundException.
 */

fun dialPhone(context: Context, phone: String?): Boolean {
    val cleaned = phone?.filter { it.isDigit() || it == '+' }?.trim()
    if (cleaned.isNullOrBlank()) return false
    return try {
        context.startActivity(Intent(Intent.ACTION_DIAL, "tel:$cleaned".toUri()))
        true
    } catch (_: Exception) {
        false
    }
}

fun openMap(context: Context, address: String?, lat: Double? = null, lng: Double? = null): Boolean {
    val uri: Uri = when {
        lat != null && lng != null -> "geo:$lat,$lng?q=$lat,$lng".toUri()
        !address.isNullOrBlank() -> "geo:0,0?q=${Uri.encode(address)}".toUri()
        else -> return false
    }
    return try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
        true
    } catch (_: Exception) {
        false
    }
}

/**
 * Format a quantity the way the operator reads it: no trailing zeros, and never
 * scientific notation for small decimals.
 */
fun formatQty(value: Double): String {
    if (value == value.toLong().toDouble()) return value.toLong().toString()
    return String.format(java.util.Locale.US, "%.4f", value).trimEnd('0').trimEnd('.')
}

fun formatQty(value: String?): String {
    val parsed = value?.toDoubleOrNull() ?: return "—"
    return formatQty(parsed)
}

/** «قبل 5 دقائق» — used by the offline banner and the notification list. */
fun relativeTime(epochMillis: Long): String {
    val delta = System.currentTimeMillis() - epochMillis
    val minutes = delta / 60_000
    return when {
        minutes < 1 -> "الآن"
        minutes < 60 -> "قبل $minutes دقيقة"
        minutes < 1440 -> "قبل ${minutes / 60} ساعة"
        else -> "قبل ${minutes / 1440} يوم"
    }
}

/** ISO-8601 → a short, readable local form. Falls back to the raw value. */
fun formatDateTime(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return runCatching {
        val parsed = java.time.OffsetDateTime.parse(iso)
        val local = parsed.atZoneSameInstant(java.time.ZoneId.systemDefault())
        val date = local.toLocalDate().format(java.time.format.DateTimeFormatter.ofPattern("yyyy/MM/dd"))
        val time = local.toLocalTime().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
        "$date - $time"
    }.getOrElse { iso }
}

fun formatDate(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    return runCatching {
        val parsed = java.time.OffsetDateTime.parse(iso)
        parsed.atZoneSameInstant(java.time.ZoneId.systemDefault())
            .toLocalDate()
            .format(java.time.format.DateTimeFormatter.ofPattern("yyyy/MM/dd"))
    }.getOrElse { iso }
}
