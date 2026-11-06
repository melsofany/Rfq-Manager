package com.cortoba.fieldops.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.cortoba.fieldops.R

private val LightColors = lightColorScheme(
    primary = CortobaBrown,
    onPrimary = CortobaCream,
    primaryContainer = CortobaCoral,
    onPrimaryContainer = CortobaCharcoal,
    secondary = CortobaRed,
    onSecondary = CortobaCream,
    tertiary = CortobaYellow,
    onTertiary = CortobaCharcoal,
    background = CortobaCream,
    onBackground = CortobaCharcoal,
    surface = CortobaSurface,
    onSurface = CortobaCharcoal,
    surfaceVariant = CortobaCream,
    onSurfaceVariant = CortobaCharcoal,
    outline = CortobaOutline,
    error = CortobaRed,
    onError = CortobaCream,
)

private val DarkBackground = androidx.compose.ui.graphics.Color(0xFF1F1B18)
private val DarkSurface = androidx.compose.ui.graphics.Color(0xFF2A2521)

private val DarkColors = darkColorScheme(
    primary = CortobaCoral,
    onPrimary = CortobaCharcoal,
    primaryContainer = CortobaBrown,
    onPrimaryContainer = CortobaCream,
    secondary = CortobaRed,
    tertiary = CortobaYellow,
    background = DarkBackground,
    onBackground = CortobaCream,
    surface = DarkSurface,
    onSurface = CortobaCream,
    error = CortobaRed,
)

/**
 * Cairo is the brand's Arabic typeface. It is bundled as three static weights
 * and declared as a family so Compose picks the right face for each
 * `fontWeight`, rather than synthesising a fake bold from one file.
 */
private val Cairo = FontFamily(
    Font(R.font.cairo_regular, FontWeight.Normal),
    Font(R.font.cairo_semibold, FontWeight.SemiBold),
    Font(R.font.cairo_bold, FontWeight.Bold),
)

/**
 * The app is Arabic-first, so the type scale is a notch larger than Material's
 * default. Field use is one-handed and often outdoors: bigger text and generous
 * line heights matter more than density here.
 */
private val CortobaTypography = Typography(
    displaySmall = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 40.sp),
    headlineMedium = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.Bold, fontSize = 26.sp, lineHeight = 36.sp),
    headlineSmall = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 30.sp),
    titleMedium = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 26.sp),
    bodyLarge = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 26.sp),
    bodyMedium = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 24.sp),
    labelLarge = TextStyle(fontFamily = Cairo, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 22.sp),
)

@Composable
fun CortobaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = CortobaTypography,
        content = content,
    )
}
