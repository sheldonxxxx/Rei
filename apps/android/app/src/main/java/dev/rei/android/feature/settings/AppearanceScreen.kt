package dev.rei.android.feature.settings

import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.RadioButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.theme.ThemePreference

private val summaries = mapOf(
    ThemePreference.System to "Follow the device’s light or dark setting",
    ThemePreference.Light to "Always light",
    ThemePreference.Dark to "Always dark",
)

/** Appearance: System, Light or Dark. The choice applies the moment it is tapped and is kept on this device. */
@Composable
fun AppearanceScreen(selected: ThemePreference, onSelect: (ThemePreference) -> Unit, onBack: () -> Unit) {
    SubScreen("Appearance", onBack) {
        SettingsGroup(title = "Theme") {
            ThemePreference.entries.forEachIndexed { index, option ->
                SettingsRow(
                    title = option.label,
                    summary = summaries.getValue(option),
                    dividerBelow = index < ThemePreference.entries.lastIndex,
                    modifier = Modifier.selectable(selected = selected == option, role = Role.RadioButton, onClick = { onSelect(option) }),
                    trailing = { RadioButton(selected = selected == option, onClick = null) },
                )
            }
        }
    }
}
