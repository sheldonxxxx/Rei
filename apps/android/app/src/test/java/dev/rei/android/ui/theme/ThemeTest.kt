package dev.rei.android.ui.theme

import androidx.activity.BackEventCompat
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTest {
    /** Every color Material 3 would show if a slot were left at its default, in either scheme. */
    private val baseline: Map<Color, String> = buildMap {
        for ((scheme, colors) in listOf("light" to lightColorScheme(), "dark" to darkColorScheme())) {
            colors.allColors().forEach { (slot, color) -> putIfAbsent(color, "$scheme $slot") }
        }
    }

    private fun assertNoBaseline(name: String, scheme: ColorScheme) {
        // Scrim is black by definition in every Material scheme.
        val stray = scheme.allColors().filter { (slot, color) -> slot != "scrim" && color in baseline }
        assertTrue("$name uses Material baseline colors: ${stray.map { (slot, color) -> "$slot = ${baseline[color]}" }}", stray.isEmpty())
    }

    @Test
    fun lightSchemeHasNoMaterialBaselineColor() = assertNoBaseline("light", EngawaLightColorScheme)

    @Test
    fun darkSchemeHasNoMaterialBaselineColor() = assertNoBaseline("dark", EngawaDarkColorScheme)

    @Test
    fun schemesFollowTheEngawaTable() {
        assertEquals(Color(0xFFF7F5F1), EngawaLightColorScheme.background)
        assertEquals(Color(0xFF1C1A19), EngawaDarkColorScheme.background)
        assertEquals(Color(0xFF736052), EngawaLightColorScheme.primary)
        assertEquals(Color(0xFFAE9680), EngawaDarkColorScheme.primary)
        assertEquals(Color(0xFFFFFEFC), EngawaLightColorScheme.surfaceContainerLowest)
        assertEquals(Color(0xFFDED7CF), EngawaLightColorScheme.secondaryContainer)
        assertEquals(Color(0xFF927147), EngawaLightColorScheme.tertiary)
        assertEquals(Color(0xFFA93636), EngawaLightColorScheme.error)
        assertEquals(Color(0xFFED998F), EngawaDarkColorScheme.error)
    }

    @Test
    fun textKeepsReadableContrastOnItsSurface() {
        for ((name, scheme) in listOf("light" to EngawaLightColorScheme, "dark" to EngawaDarkColorScheme)) {
            assertTrue("$name text on canvas", contrast(scheme.onSurface, scheme.background) >= 7.0)
            assertTrue("$name supporting text on canvas", contrast(scheme.onSurfaceVariant, scheme.background) >= 4.5)
            assertTrue("$name primary button", contrast(scheme.onPrimary, scheme.primary) >= 4.5)
            assertTrue("$name attention text", contrast(scheme.onTertiaryContainer, scheme.tertiaryContainer) >= 4.5)
            assertTrue("$name control border", contrast(scheme.outline, scheme.background) >= 3.0)
        }
    }

    @Test
    fun themePreferenceParsesStoredValues() {
        assertEquals(ThemePreference.System, ThemePreference.parse(null))
        assertEquals(ThemePreference.System, ThemePreference.parse("nonsense"))
        assertEquals(ThemePreference.Dark, ThemePreference.parse("Dark"))
        assertEquals(ThemePreference.Light, ThemePreference.parse(ThemePreference.Light.name))
    }

    @Test
    fun motionStaggerIsCapped() {
        assertEquals(0, ReiMotion.delayFor(0))
        assertEquals(24, ReiMotion.delayFor(1))
        assertEquals(ReiMotion.StaggerCapMs, ReiMotion.delayFor(40))
        assertTrue(ReiEnter.entries.all { it.durationMs <= ReiMotion.CeilingMs })
        assertTrue(ReiMotion.ExitMs < ReiEnter.Fade.durationMs)
    }

    @Test
    fun predictivePopRespectsReducedMotion() {
        assertEquals(EnterTransition.None, ReiMotion.predictivePopEnter(scale = 0f))
        assertEquals(ExitTransition.None, ReiMotion.predictivePopExit(BackEventCompat.EDGE_LEFT, scale = 0f))
        assertTrue(ReiMotion.predictivePopEnter(scale = 1f) != EnterTransition.None)
        assertTrue(ReiMotion.predictivePopExit(BackEventCompat.EDGE_LEFT, scale = 1f) != ExitTransition.None)
        assertTrue(ReiMotion.predictivePopExit(BackEventCompat.EDGE_RIGHT, scale = 1f) != ExitTransition.None)
    }

    private fun contrast(a: Color, b: Color): Double {
        val (hi, lo) = listOf(a.luminance(), b.luminance()).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }
}
