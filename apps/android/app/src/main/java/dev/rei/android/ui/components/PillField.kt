package dev.rei.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

/**
 * The rounded-full field used for search and, in phase 2, as the base of the composer: a pill on the card color with the
 * control-border edge, an optional [leadingIcon], a [placeholder], a clear button once there is text, and a free
 * [trailing] slot. [description] names the field for accessibility ("Search chats").
 */
@Composable
fun PillField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    description: String = placeholder,
    leadingIcon: ImageVector? = null,
    trailing: @Composable (() -> Unit)? = null,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 6,
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    clearable: Boolean = true,
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outline), ReiShapes.Pill),
        shape = ReiShapes.Pill,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
    ) {
        Row(
            Modifier.padding(start = if (leadingIcon != null) 14.dp else 18.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (leadingIcon != null) {
                Icon(leadingIcon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(Modifier.weight(1f).padding(vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) {
                    Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = description },
                    singleLine = singleLine,
                    maxLines = maxLines,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = keyboardOptions,
                    keyboardActions = keyboardActions,
                )
            }
            if (clearable && value.isNotEmpty()) ReiIconButton(ReiIcons.Close, "Clear", { onValueChange("") })
            trailing?.invoke()
        }
    }
}

@ReiPreviews
@Composable
private fun PillFieldPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PillField("", {}, "Search chats", leadingIcon = ReiIcons.Search)
        PillField("quarterly report", {}, "Search chats", leadingIcon = ReiIcons.Search)
    }
}
