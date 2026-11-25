package dev.rei.android.ui.theme

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView

val LocalReiColors = staticCompositionLocalOf { EngawaLightReiColors }

/** API 28-compatible translucent dark scrim for light-mode system navigation bars when contrast protection is needed. */
private val LightModeNavigationScrim = Color.argb(0x80, 0x1B, 0x1B, 0x1B)

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
        DisposableEffect(activity, dark) {
            if (activity != null) {
                val statusStyle = if (dark) {
                    SystemBarStyle.dark(Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(Color.TRANSPARENT, LightModeNavigationScrim)
                }
                val navStyle = if (dark) {
                    SystemBarStyle.dark(Color.TRANSPARENT)
                } else {
                    SystemBarStyle.light(Color.TRANSPARENT, LightModeNavigationScrim)
                }
                activity.enableEdgeToEdge(statusBarStyle = statusStyle, navigationBarStyle = navStyle)
            }
            onDispose {}
        }
    }
    CompositionLocalProvider(
        LocalReiColors provides colors,
        LocalMotionScale provides rememberAnimatorScale(),
    ) {
        MaterialTheme(colorScheme = scheme, typography = ReiTypography, shapes = ReiMaterialShapes, content = content)
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
