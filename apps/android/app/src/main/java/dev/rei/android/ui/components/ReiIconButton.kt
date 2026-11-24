package dev.rei.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

/**
 * A quiet icon button. [contentDescription] is the full word ("Download", "Move to Trash"): TalkBack and tests find the
 * button by it, and a long press shows it as a tooltip. The touch target is at least 48dp.
 *
 * Pass [toggled] for a toggle: it reads as a switch to accessibility services and fills when on.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReiIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    toggled: Boolean? = null,
    tint: Color = Color.Unspecified,
    iconSize: Dp = 24.dp,
) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(contentDescription) } },
        state = rememberTooltipState(),
    ) {
        if (toggled == null) {
            IconButton(onClick = onClick, enabled = enabled, modifier = modifier) {
                val baseTint = tint.orContent()
                Icon(
                    icon,
                    contentDescription = contentDescription,
                    tint = if (enabled) baseTint else baseTint.copy(alpha = 0.38f),
                    modifier = Modifier.size(iconSize),
                )
            }
        } else {
            Box(
                modifier
                    .minimumInteractiveComponentSize()
                    .size(40.dp)
                    .clip(ReiShapes.Pill)
                    .background(if (toggled) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                    .toggleable(value = toggled, enabled = enabled, role = Role.Switch, onValueChange = { onClick() }),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon,
                    contentDescription = contentDescription,
                    tint = (if (enabled) tint.orContent() else tint.orContent().copy(alpha = 0.38f)),
                    modifier = Modifier.size(iconSize),
                )
            }
        }
    }
}

@Composable
private fun Color.orContent(): Color = if (this == Color.Unspecified) LocalContentColor.current else this

@ReiPreviews
@Composable
private fun ReiIconButtonPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Row {
        ReiIconButton(ReiIcons.Search, "Search", {})
        ReiIconButton(ReiIcons.Eye, "Show details", {}, toggled = true)
        ReiIconButton(ReiIcons.Trash, "Move to Trash", {}, enabled = false)
    }
}
