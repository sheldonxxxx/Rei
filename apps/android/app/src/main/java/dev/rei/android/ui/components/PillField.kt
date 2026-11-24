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
import androidx.compose.foundation.text.KeyboardActionScope
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.KeyboardActionHandler
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

/**
 * The [TextFieldState]-backed rounded-full field used for search: a pill on the card color with the control-border
 * edge, an optional [leadingIcon], a [placeholder], a clear button once there is text, and a free [trailing] slot.
 * [description] names the field for accessibility ("Search chats").
 */
@Composable
fun PillField(
    state: TextFieldState,
    placeholder: String,
    modifier: Modifier = Modifier,
    description: String = placeholder,
    leadingIcon: ImageVector? = null,
    trailing: @Composable (() -> Unit)? = null,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 6,
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    onKeyboardAction: KeyboardActionHandler? = null,
    clearable: Boolean = true,
) {
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .border(BorderStroke(1.dp, MaterialTheme.colorScheme.outline), ReiShapes.Pill),
        shape = ReiShapes.Pill,
        color = ReiTheme.colors.card,
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
                if (state.text.isEmpty()) {
                    Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                BasicTextField(
                    state = state,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = description },
                    lineLimits = if (singleLine) TextFieldLineLimits.SingleLine else TextFieldLineLimits.MultiLine(maxHeightInLines = maxLines),
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = keyboardOptions,
                    onKeyboardAction = onKeyboardAction,
                )
            }
            if (clearable && state.text.isNotEmpty()) ReiIconButton(ReiIcons.Close, "Clear", { state.clearText() })
            trailing?.invoke()
        }
    }
}

/**
 * The rounded-full field used for search: a pill on the card color with the control-border edge, an optional
 * [leadingIcon], a [placeholder], a clear button once there is text, and a free [trailing] slot. [description] names
 * the field for accessibility ("Search chats").
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
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    clearable: Boolean = true,
) {
    val textState = rememberTextFieldState(value)
    val latestValue by rememberUpdatedState(value)
    val latestOnValueChange by rememberUpdatedState(onValueChange)
    val latestActions by rememberUpdatedState(keyboardActions)
    val latestOptions by rememberUpdatedState(keyboardOptions)

    LaunchedEffect(value) {
        if (value != textState.text.toString()) {
            textState.setTextAndPlaceCursorAtEnd(value)
        }
    }
    LaunchedEffect(textState) {
        snapshotFlow { textState.text.toString() }.collect { typed ->
            if (typed != latestValue) latestOnValueChange(typed)
        }
    }

    PillField(
        state = textState,
        placeholder = placeholder,
        modifier = modifier,
        description = description,
        leadingIcon = leadingIcon,
        trailing = trailing,
        singleLine = singleLine,
        maxLines = maxLines,
        keyboardOptions = keyboardOptions,
        onKeyboardAction = KeyboardActionHandler { performDefault ->
            val scope = object : KeyboardActionScope {
                override fun defaultKeyboardAction(imeAction: ImeAction) = performDefault()
            }
            val handler = when (latestOptions.imeAction) {
                ImeAction.Done -> latestActions.onDone
                ImeAction.Go -> latestActions.onGo
                ImeAction.Search -> latestActions.onSearch
                ImeAction.Send -> latestActions.onSend
                ImeAction.Next -> latestActions.onNext
                ImeAction.Previous -> latestActions.onPrevious
                else -> null
            }
            if (handler != null) handler.invoke(scope) else performDefault()
        },
        clearable = clearable,
    )
}

@ReiPreviews
@Composable
private fun PillFieldPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PillField("", {}, "Search chats", leadingIcon = ReiIcons.Search)
        PillField("quarterly report", {}, "Search chats", leadingIcon = ReiIcons.Search)
    }
}
