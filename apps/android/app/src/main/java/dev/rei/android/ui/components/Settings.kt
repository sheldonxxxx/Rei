package dev.rei.android.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.tabular

/**
 * One settings section in the Android 16 style: an optional [title] above an 18dp rounded card on
 * `surfaceContainerLowest`. Put [SettingsRow]s inside; set `dividerBelow` on every row but the last.
 */
@Composable
fun SettingsGroup(
    modifier: Modifier = Modifier,
    title: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth()) {
        if (title != null) SectionHeader(title)
        Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = ReiShapes.Card,
            color = MaterialTheme.colorScheme.surfaceContainerLowest,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(Modifier.clip(ReiShapes.Card), content = content)
        }
    }
}

/**
 * A row 56dp or taller: leading [icon], [title], an optional [summary], then a [trailing] affordance
 * ([SettingsChevron], a switch, or any composable). Rows with [onClick] are one touch target.
 */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    summary: String? = null,
    onClick: (() -> Unit)? = null,
    destructive: Boolean = false,
    dividerBelow: Boolean = false,
    /** Numbers and durations in the summary use tabular figures, so columns of rows line up. */
    tabularSummary: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Column {
        Row(
            modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (icon != null) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = if (destructive) color else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(24.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
                if (summary != null) {
                    Text(
                        summary,
                        style = if (tabularSummary) MaterialTheme.typography.bodyMedium.tabular() else MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 8,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            trailing?.invoke()
        }
        if (dividerBelow) {
            HorizontalDivider(Modifier.padding(start = if (icon != null) 56.dp else 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** A row that holds a switch; the whole row toggles and reads as a switch. */
@Composable
fun SettingsSwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    summary: String? = null,
    enabled: Boolean = true,
    dividerBelow: Boolean = false,
) {
    SettingsRow(
        title = title,
        icon = icon,
        summary = summary,
        dividerBelow = dividerBelow,
        modifier = modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange),
        trailing = { Switch(checked = checked, onCheckedChange = null, enabled = enabled, modifier = Modifier.clearAndSetSemantics { }) },
    )
}

@Composable
fun SettingsChevron(tint: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Icon(ReiIcons.Forward, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
}

@ReiPreviews
@Composable
private fun SettingsPreview() = ReiPreviewSurface {
    val dark = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(true) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SettingsGroup(title = "App") {
            SettingsRow("Appearance", icon = ReiIcons.Eye, summary = "System", onClick = {}, dividerBelow = true, trailing = { SettingsChevron() })
            SettingsSwitchRow("Show details by default", dark.value, { dark.value = it }, icon = ReiIcons.Sliders)
        }
        SettingsGroup(title = "Rei") {
            SettingsRow("Providers", icon = ReiIcons.Globe, onClick = {}, dividerBelow = true, trailing = { SettingsChevron() })
            SettingsRow("Disconnect server", icon = ReiIcons.Logout, onClick = {}, destructive = true)
        }
    }
}
