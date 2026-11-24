package dev.rei.android.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
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
    dismissLabel: String? = null,
) {
    val resolvedDismiss = dismissLabel ?: stringResource(R.string.common_cancel)
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = ReiShapes.Dialog,
        containerColor = ReiTheme.colors.card,
        title = { Text(title) },
        text = { Text(text) },
        dismissButton = { TextButton(onDismiss) { Text(resolvedDismiss) } },
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
    ConfirmDialog(
        title = stringResource(R.string.settings_sign_out_confirm_title),
        text = stringResource(R.string.settings_sign_out_confirm_body),
        confirmLabel = stringResource(R.string.settings_sign_out_action),
        onConfirm = {},
        onDismiss = {},
        destructive = true,
    )
}
