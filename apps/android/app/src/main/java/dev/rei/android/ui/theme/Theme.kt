package dev.rei.android.ui.theme

import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView

val LocalReiColors = compositionLocalOf { EngawaLightReiColors }

/** Read the tokens Material 3 has no slot for: `ReiTheme.colors.attentionBorder`. */
object ReiTheme {
    val colors: ReiColors
        @Composable @ReadOnlyComposable get() = LocalReiColors.current
}

/**
 * The Engawa theme. [preference] picks System (default), Light or Dark; there is no dynamic color. When hosted by a
 * [ComponentActivity] it also draws edge to edge with status and navigation bar icons that follow the scheme.
 */
@Composable
fun ReiTheme(preference: ThemePreference = ThemePreference.System, content: @Composable () -> Unit) {
    val dark = when (preference) {
        ThemePreference.System -> isSystemInDarkTheme()
        ThemePreference.Light -> false
        ThemePreference.Dark -> true
    }
    val scheme = if (dark) EngawaDarkColorScheme else EngawaLightColorScheme
    val colors = if (dark) EngawaDarkReiColors else EngawaLightReiColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        val activity = LocalContext.current.findActivity() as? ComponentActivity
        SideEffect {
            val transparent = android.graphics.Color.TRANSPARENT
            val bars = if (dark) SystemBarStyle.dark(transparent) else SystemBarStyle.light(transparent, transparent)
            activity?.enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
        }
    }
    CompositionLocalProvider(
        LocalReiColors provides colors,
        LocalMotionScale provides rememberAnimatorScale(),
    ) {
        MaterialTheme(colorScheme = scheme, typography = ReiTypography, shapes = ReiMaterialShapes, content = content)
    }
}

private tailrec fun android.content.Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is android.content.ContextWrapper -> baseContext.findActivity()
    else -> null
}
