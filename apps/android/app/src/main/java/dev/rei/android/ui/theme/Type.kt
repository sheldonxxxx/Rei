package dev.rei.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** One sans family (the system's: Roboto, with Noto CJK as its fallback) and one mono family for code, tool calls and IDs. */
val ReiSans: FontFamily = FontFamily.Default
val ReiMono: FontFamily = FontFamily.Monospace

private fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, tracking: Float = 0f) =
    TextStyle(
        fontFamily = ReiSans,
        fontSize = size.sp,
        lineHeight = line.sp,
        fontWeight = weight,
        letterSpacing = tracking.em,
    )

/** Conversation and reading text is 16/24; metadata 12–14; screen titles 22; workspace titles 24–28. */
val ReiTypography = Typography(
    displayLarge = style(40, 48, FontWeight.SemiBold),
    displayMedium = style(34, 42, FontWeight.SemiBold),
    displaySmall = style(30, 38, FontWeight.SemiBold),
    headlineLarge = style(28, 36, FontWeight.SemiBold),
    headlineMedium = style(26, 34, FontWeight.SemiBold),
    headlineSmall = style(24, 32, FontWeight.SemiBold),
    titleLarge = style(22, 28, FontWeight.SemiBold),
    titleMedium = style(16, 24, FontWeight.Medium),
    titleSmall = style(14, 20, FontWeight.Medium),
    bodyLarge = style(16, 24),
    bodyMedium = style(14, 20),
    bodySmall = style(12, 16),
    labelLarge = style(14, 20, FontWeight.Medium),
    labelMedium = style(12, 16, FontWeight.Medium),
    labelSmall = style(12, 16, FontWeight.Medium),
)

/** Tabular figures for counts, durations and other numbers that change in place. */
fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = "tnum")

/** Mono for code, tool calls and IDs. */
fun TextStyle.mono(): TextStyle = copy(fontFamily = ReiMono)
