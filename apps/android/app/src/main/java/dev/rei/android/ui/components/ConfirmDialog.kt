package dev.rei.android.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

/**
 * Asks before something that cannot be undone. [text] says what will be lost or what happens next in plain words
 * ("This removes the conversation and its searchable history."). [destructive] colors the confirm action in the error color.
 */
@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = false,
    dismissLabel: String = "Cancel",
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = ReiShapes.Dialog,
        containerColor = ReiTheme.colors.card,
        title = { Text(title) },
        text = { Text(text) },
        dismissButton = { TextButton(onDismiss) { Text(dismissLabel) } },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    containerColor = Color.Transparent,
                ),
            ) { Text(confirmLabel) }
        },
    )
}

@ReiPreviews
@Composable
private fun ConfirmDialogPreview() = ReiPreviewSurface {
    // AlertDialog is a window and does not render in a static preview; this guards the signature and the theme wiring.
    Text("Delete this chat? Confirm dialog preview", color = MaterialTheme.colorScheme.error)
}
