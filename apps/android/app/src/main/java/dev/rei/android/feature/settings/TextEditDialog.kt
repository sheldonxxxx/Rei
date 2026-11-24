package dev.rei.android.feature.settings

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.VisualTransformation
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes

/** A dialog with one text field: rename a device, edit a memory entry, add a line. Save stays off until there is a change within [limit]. */
@Composable
fun TextEditDialog(
    title: String,
    label: String,
    initial: String,
    limit: Int,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
    singleLine: Boolean = limit <= 120,
    saveLabel: String = "Save",
) {
    var value by remember { mutableStateOf(initial) }
    val trimmed = value.trim()
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = ReiShapes.Dialog,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        title = { Text(title) },
        text = {
            ReiTextField(
                value = value,
                onValueChange = { value = it },
                label = label,
                singleLine = singleLine,
                minLines = if (singleLine) 1 else 3,
                error = if (value.length > limit) "Use at most $limit characters." else null,
                visualTransformation = VisualTransformation.None,
            )
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
        confirmButton = {
            TextButton(onClick = { onSave(trimmed) }, enabled = trimmed.isNotEmpty() && trimmed != initial && value.length <= limit) { Text(saveLabel) }
        },
    )
}
