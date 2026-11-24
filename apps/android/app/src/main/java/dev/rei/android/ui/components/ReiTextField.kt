package dev.rei.android.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

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
    val hint = error ?: supportingText
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
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
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        visualTransformation = visualTransformation,
        shape = if (singleLine) ReiShapes.Pill else ReiShapes.Card,
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            errorContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
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

@ReiPreviews
@Composable
private fun ReiTextFieldPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
        ReiTextField("https://rei.example.com", {}, "Rei server address", leadingIcon = ReiIcons.Globe)
        ReiTextField("", {}, "Password", supportingText = "Use at least 12 characters.")
        ReiTextField("sample", {}, "Authenticator code", error = "The authenticator code is wrong.")
    }
}
