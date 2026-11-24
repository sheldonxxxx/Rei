package dev.rei.android.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Engawa on Material 3. Values come from the tokens in `apps/web/src/index.css`, mapped to M3 roles below.
 * Every M3 slot is set explicitly so no baseline
 * purple can show, and dynamic color is never used: the palette is the brand and has to match web.
 */
private object Light {
    val canvas = Color(0xFFF7F5F1)
    val card = Color(0xFFFFFEFC)
    val muted = Color(0xFFF2EFEB)
    val sidebar = Color(0xFFEEEAE5)
    val accent = Color(0xFFDED7CF)
    val foreground = Color(0xFF292725)
    val supporting = Color(0xFF716B65)
    val primary = Color(0xFF736052)
    val border = Color(0xFFDCD6CE)
    val controlBorder = Color(0xFF82776D)
    val destructive = Color(0xFFA93636)
    val attention = Color(0xFF927147)
    val attentionSoft = Color(0xFFF6ECDD)
    val attentionText = Color(0xFF755633)
}

private object Dark {
    val canvas = Color(0xFF1C1A19)
    val card = Color(0xFF302C29)
    val sidebar = Color(0xFF242120)
    val accent = Color(0xFF544B45)
    val foreground = Color(0xFFEEE9E2)
    val supporting = Color(0xFFB3AAA1)
    val primary = Color(0xFFAE9680)
    val border = Color(0xFF49423D)
    val controlBorder = Color(0xFFA99A8E)
    val destructive = Color(0xFFED998F)
    val attention = Color(0xFFC3A57B)
    val attentionSoft = Color(0xFF3A3027)
    val attentionText = Color(0xFFDABD95)
}

val EngawaLightColorScheme: ColorScheme = lightColorScheme(
    primary = Light.primary,
    onPrimary = Light.card,
    primaryContainer = Color(0xFFEADFD4),
    onPrimaryContainer = Color(0xFF3F342B),
    inversePrimary = Color(0xFFAE9680),
    secondary = Light.supporting,
    onSecondary = Light.card,
    secondaryContainer = Light.accent,
    onSecondaryContainer = Light.foreground,
    tertiary = Light.attention,
    onTertiary = Light.card,
    tertiaryContainer = Light.attentionSoft,
    onTertiaryContainer = Light.attentionText,
    background = Light.canvas,
    onBackground = Light.foreground,
    surface = Light.canvas,
    onSurface = Light.foreground,
    surfaceVariant = Light.sidebar,
    onSurfaceVariant = Light.supporting,
    surfaceTint = Light.primary,
    inverseSurface = Light.foreground,
    inverseOnSurface = Light.canvas,
    error = Light.destructive,
    onError = Light.card,
    errorContainer = Color(0xFFF6DDD9),
    onErrorContainer = Color(0xFF7B2323),
    outline = Light.controlBorder,
    outlineVariant = Light.border,
    scrim = Color(0xFF000000),
    surfaceBright = Light.card,
    surfaceDim = Color(0xFFE9E5DF),
    surfaceContainerLowest = Light.card,
    surfaceContainerLow = Light.muted,
    surfaceContainer = Light.sidebar,
    surfaceContainerHigh = Light.sidebar,
    surfaceContainerHighest = Light.accent,
    primaryFixed = Color(0xFFEADFD4),
    primaryFixedDim = Color(0xFFD7C6B6),
    onPrimaryFixed = Color(0xFF2D231B),
    onPrimaryFixedVariant = Color(0xFF56473C),
    secondaryFixed = Light.accent,
    secondaryFixedDim = Color(0xFFCDC4BA),
    onSecondaryFixed = Light.foreground,
    onSecondaryFixedVariant = Color(0xFF56504A),
    tertiaryFixed = Light.attentionSoft,
    tertiaryFixedDim = Color(0xFFE5D1B4),
    onTertiaryFixed = Color(0xFF342310),
    onTertiaryFixedVariant = Light.attentionText,
)

val EngawaDarkColorScheme: ColorScheme = darkColorScheme(
    primary = Dark.primary,
    onPrimary = Dark.canvas,
    primaryContainer = Color(0xFF4A3F37),
    onPrimaryContainer = Color(0xFFE9DDD2),
    inversePrimary = Color(0xFF736052),
    secondary = Dark.supporting,
    onSecondary = Dark.canvas,
    secondaryContainer = Dark.accent,
    onSecondaryContainer = Dark.foreground,
    tertiary = Dark.attention,
    onTertiary = Dark.canvas,
    tertiaryContainer = Dark.attentionSoft,
    onTertiaryContainer = Dark.attentionText,
    background = Dark.canvas,
    onBackground = Dark.foreground,
    surface = Dark.canvas,
    onSurface = Dark.foreground,
    surfaceVariant = Dark.card,
    onSurfaceVariant = Dark.supporting,
    surfaceTint = Dark.primary,
    inverseSurface = Dark.foreground,
    inverseOnSurface = Dark.canvas,
    error = Dark.destructive,
    onError = Dark.canvas,
    errorContainer = Color(0xFF4A2724),
    onErrorContainer = Color(0xFFF5C4BE),
    outline = Dark.controlBorder,
    outlineVariant = Dark.border,
    scrim = Color(0xFF000000),
    surfaceBright = Color(0xFF3B3632),
    surfaceDim = Color(0xFF151312),
    // Monotonic dark surface ladder so M3 tonal elevation steps cleanly from canvas outward.
    surfaceContainerLowest = Color(0xFF151312),
    surfaceContainerLow = Color(0xFF1E1B1A),
    surfaceContainer = Dark.sidebar,
    surfaceContainerHigh = Dark.card,
    surfaceContainerHighest = Color(0xFF3B3632),
    primaryFixed = Color(0xFFEADFD4),
    primaryFixedDim = Color(0xFFD7C6B6),
    onPrimaryFixed = Color(0xFF2D231B),
    onPrimaryFixedVariant = Color(0xFF56473C),
    secondaryFixed = Color(0xFFDED7CF),
    secondaryFixedDim = Color(0xFFCDC4BA),
    onSecondaryFixed = Color(0xFF292725),
    onSecondaryFixedVariant = Color(0xFF56504A),
    tertiaryFixed = Color(0xFFF6ECDD),
    tertiaryFixedDim = Color(0xFFE5D1B4),
    onTertiaryFixed = Color(0xFF342310),
    onTertiaryFixedVariant = Color(0xFF755633),
)

/** Tokens Material 3 has no slot for. Read them with `ReiTheme.colors` (the web names, camel-cased). */
@Immutable
data class ReiColors(
    /** `--supporting-text-strong`: supporting text on inset and selected surfaces. */
    val supportingTextStrong: Color,
    /** `--attention-border`: the ochre edge of an approval. */
    val attentionBorder: Color,
    /** `--card`: cards and panels (`#FFFEFC` in light, `#302C29` in dark). */
    val card: Color,
    val syntaxKeyword: Color,
    val syntaxString: Color,
    val syntaxNumber: Color,
    /** `--chart-1` … `--chart-8`. */
    val charts: List<Color>,
    /** Tints of the built-in bot avatars (`--bot-*`). */
    val bot: BotTints,
)

@Immutable
data class BotTints(
    val ink: Color,
    val paper: Color,
    val bonsai: Color,
    val stone: Color,
    val lantern: Color,
    val luckyCat: Color,
    val crane: Color,
    val moonRabbit: Color,
)

private val BotTintsEngawa = BotTints(
    ink = Color(0xFF292725),
    paper = Color(0xFFEDE5D8),
    bonsai = Color(0xFF81846E),
    stone = Color(0xFFAB9F91),
    lantern = Color(0xFFCFB288),
    luckyCat = Color(0xFFB99A68),
    crane = Color(0xFFC3B2A1),
    moonRabbit = Color(0xFFBFB19E),
)

val EngawaLightReiColors = ReiColors(
    supportingTextStrong = Color(0xFF625C56),
    attentionBorder = Light.attention,
    card = Light.card,
    syntaxKeyword = Color(0xFF7140A0),
    syntaxString = Color(0xFF25703B),
    syntaxNumber = Color(0xFF955B15),
    charts = listOf(
        Light.primary, Color(0xFF935D55), Color(0xFF5B6D83), Color(0xFF896277),
        Color(0xFF67724E), Color(0xFF4B787B), Color(0xFF706486), Color(0xFF82683C),
    ),
    bot = BotTintsEngawa,
)

val EngawaDarkReiColors = ReiColors(
    supportingTextStrong = Color(0xFFC9BFB5),
    attentionBorder = Dark.attention,
    card = Dark.card,
    syntaxKeyword = Color(0xFFC5A3EE),
    syntaxString = Color(0xFF91C79C),
    syntaxNumber = Color(0xFFE9B778),
    charts = listOf(
        Dark.primary, Color(0xFFCE9B91), Color(0xFF9EAEC1), Color(0xFFC5A0B6),
        Color(0xFFA9B187), Color(0xFF88B4B5), Color(0xFFB1A3C3), Color(0xFFC3AD84),
    ),
    bot = BotTintsEngawa,
)

/** Every color of a scheme, for tests that look for stray baseline colors. */
fun ColorScheme.allColors(): Map<String, Color> = mapOf(
    "primary" to primary, "onPrimary" to onPrimary, "primaryContainer" to primaryContainer,
    "onPrimaryContainer" to onPrimaryContainer, "inversePrimary" to inversePrimary,
    "secondary" to secondary, "onSecondary" to onSecondary, "secondaryContainer" to secondaryContainer,
    "onSecondaryContainer" to onSecondaryContainer, "tertiary" to tertiary, "onTertiary" to onTertiary,
    "tertiaryContainer" to tertiaryContainer, "onTertiaryContainer" to onTertiaryContainer,
    "background" to background, "onBackground" to onBackground, "surface" to surface, "onSurface" to onSurface,
    "surfaceVariant" to surfaceVariant, "onSurfaceVariant" to onSurfaceVariant, "surfaceTint" to surfaceTint,
    "inverseSurface" to inverseSurface, "inverseOnSurface" to inverseOnSurface, "error" to error,
    "onError" to onError, "errorContainer" to errorContainer, "onErrorContainer" to onErrorContainer,
    "outline" to outline, "outlineVariant" to outlineVariant, "scrim" to scrim,
    "surfaceBright" to surfaceBright, "surfaceDim" to surfaceDim,
    "surfaceContainerLowest" to surfaceContainerLowest, "surfaceContainerLow" to surfaceContainerLow,
    "surfaceContainer" to surfaceContainer, "surfaceContainerHigh" to surfaceContainerHigh,
    "surfaceContainerHighest" to surfaceContainerHighest,
    "primaryFixed" to primaryFixed, "primaryFixedDim" to primaryFixedDim,
    "onPrimaryFixed" to onPrimaryFixed, "onPrimaryFixedVariant" to onPrimaryFixedVariant,
    "secondaryFixed" to secondaryFixed, "secondaryFixedDim" to secondaryFixedDim,
    "onSecondaryFixed" to onSecondaryFixed, "onSecondaryFixedVariant" to onSecondaryFixedVariant,
    "tertiaryFixed" to tertiaryFixed, "tertiaryFixedDim" to tertiaryFixedDim,
    "onTertiaryFixed" to onTertiaryFixed, "onTertiaryFixedVariant" to onTertiaryFixedVariant,
)
