package dev.rei.android.feature.settings

import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.RadioButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import dev.rei.android.R
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.theme.ThemePreference

private val summaries = mapOf(
    ThemePreference.System to R.string.theme_system_summary,
    ThemePreference.Light to R.string.theme_light_summary,
    ThemePreference.Dark to R.string.theme_dark_summary,
)

/** Appearance: System, Light or Dark. The choice applies the moment it is tapped and is kept on this device. */
@Composable
fun AppearanceScreen(selected: ThemePreference, onSelect: (ThemePreference) -> Unit, onBack: () -> Unit) {
    SubScreen(stringResource(R.string.settings_page_appearance), onBack) {
        SettingsGroup(title = stringResource(R.string.theme_section_title)) {
            ThemePreference.entries.forEachIndexed { index, option ->
                SettingsRow(
                    title = stringResource(option.labelRes),
                    summary = stringResource(summaries.getValue(option)),
                    dividerBelow = index < ThemePreference.entries.lastIndex,
                    modifier = Modifier.selectable(selected = selected == option, role = Role.RadioButton, onClick = { onSelect(option) }),
                    trailing = { RadioButton(selected = selected == option, onClick = null) },
                )
            }
        }
    }
}
