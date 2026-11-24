package dev.rei.android.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActionScope
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.KeyboardActionHandler
import androidx.compose.foundation.text.input.OutputTransformation
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

private val PasswordMaskOutputTransformation = OutputTransformation {
    for (i in 0 until length) replace(i, i + 1, "\u2022")
}

/**
 * A [TextFieldState]-backed rounded outlined field on the card color.
 */
@Composable
fun ReiTextField(
    state: TextFieldState,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    error: String? = null,
    supportingText: String? = null,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    onKeyboardAction: KeyboardActionHandler? = null,
    outputTransformation: OutputTransformation? = null,
    leadingIcon: ImageVector? = null,
    trailingContent: @Composable (() -> Unit)? = null,
    contentType: ContentType? = null,
) {
    val hint = error ?: supportingText
    OutlinedTextField(
        state = state,
        modifier = modifier
            .fillMaxWidth()
            .semantics {
                if (error != null) error(error)
                if (contentType != null) this.contentType = contentType
            },
        enabled = enabled,
        readOnly = readOnly,
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        leadingIcon = leadingIcon?.let { { Icon(it, contentDescription = null) } },
        trailingIcon = trailingContent,
        supportingText = hint?.let { { Text(it) } },
        isError = error != null,
        lineLimits = if (singleLine) {
            TextFieldLineLimits.SingleLine
        } else {
            TextFieldLineLimits.MultiLine(minHeightInLines = minLines, maxHeightInLines = maxLines)
        },
        keyboardOptions = keyboardOptions,
        onKeyboardAction = onKeyboardAction,
        outputTransformation = outputTransformation,
        shape = if (singleLine) ReiShapes.Pill else ReiShapes.Card,
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = ReiTheme.colors.card,
            unfocusedContainerColor = ReiTheme.colors.card,
            disabledContainerColor = ReiTheme.colors.card,
            errorContainerColor = ReiTheme.colors.card,
            focusedBorderColor = MaterialTheme.colorScheme.primary,
            unfocusedBorderColor = MaterialTheme.colorScheme.outline,
            disabledBorderColor = MaterialTheme.colorScheme.outlineVariant,
            errorBorderColor = MaterialTheme.colorScheme.error,
            focusedLabelColor = MaterialTheme.colorScheme.primary,
            unfocusedLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            cursorColor = MaterialTheme.colorScheme.primary,
        ),
    )
}

/**
 * A fully rounded outlined field on the card color. The edge is the stronger control border so an editable field is
 * visible. An [error] shows under this field (never as a toast) and is announced; [supportingText] is the quiet hint.
 */
@Composable
fun ReiTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    error: String? = null,
    supportingText: String? = null,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    leadingIcon: ImageVector? = null,
    trailingContent: @Composable (() -> Unit)? = null,
    contentType: ContentType? = null,
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

    val outputTransformation = when (visualTransformation) {
        is PasswordVisualTransformation -> PasswordMaskOutputTransformation
        else -> null
    }
    ReiTextField(
        state = textState,
        label = label,
        modifier = modifier,
        enabled = enabled,
        readOnly = readOnly,
        error = error,
        supportingText = supportingText,
        placeholder = placeholder,
        singleLine = singleLine,
        minLines = minLines,
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
        outputTransformation = outputTransformation,
        leadingIcon = leadingIcon,
        trailingContent = trailingContent,
        contentType = contentType,
    )
}

@ReiPreviews
@Composable
private fun ReiTextFieldPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
        ReiTextField("https://rei.example.com", {}, "Rei server address", leadingIcon = ReiIcons.Globe)
        ReiTextField("", {}, "Password", supportingText = "Use at least 12 characters.")
        ReiTextField("sample", {}, "Authenticator code", error = "The authenticator code is wrong.")
    }
}
