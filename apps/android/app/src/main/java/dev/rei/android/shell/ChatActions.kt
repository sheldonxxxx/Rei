package dev.rei.android.shell

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.Session
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

/** What a long press on a chat can do. */
interface ChatActionHandler {
    fun rename(id: String, title: String)
    fun pin(id: String, pinned: Boolean)
    fun delete(id: String)
}

/**
 * The bottom sheet for one chat (Rename, Pin or Unpin, Delete) and the dialogs it opens. Delete is permanent, so it
 * confirms and says what will be lost. Dismissing closes it through [onDismiss].
 */
@Composable
fun ChatActionsSheet(session: Session, handler: ChatActionHandler, onDismiss: () -> Unit) {
    var dialog by remember(session.id) { mutableStateOf<String?>(null) }
    var title by remember(session.id) { mutableStateOf(session.title) }
    when (dialog) {
        "rename" -> AlertDialog(
            onDismissRequest = onDismiss,
            shape = ReiShapes.Dialog,
            containerColor = ReiTheme.colors.card,
            title = { Text(stringResource(R.string.drawer_chat_rename_title)) },
            text = { ReiTextField(title, { title = it }, stringResource(R.string.drawer_chat_title_label)) },
            dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.common_cancel)) } },
            confirmButton = {
                TextButton(
                    onClick = { handler.rename(session.id, title.trim()); onDismiss() },
                    enabled = title.isNotBlank(),
                ) { Text(stringResource(R.string.common_save)) }
            },
        )
        "delete" -> ConfirmDialog(
            title = stringResource(R.string.drawer_chat_delete_title),
            text = stringResource(R.string.drawer_chat_delete_body),
            confirmLabel = stringResource(R.string.common_delete),
            destructive = true,
            onConfirm = { handler.delete(session.id); onDismiss() },
            onDismiss = onDismiss,
        )
        else -> ReiSheet(onDismiss = onDismiss, title = session.title.ifBlank { stringResource(R.string.drawer_untitled_chat) }) {
            SettingsRow(stringResource(R.string.drawer_chat_rename), icon = ReiIcons.Edit, onClick = { dialog = "rename" })
            SettingsRow(
                stringResource(if (session.pinned) R.string.drawer_chat_unpin else R.string.drawer_chat_pin),
                icon = ReiIcons.Pin,
                onClick = { handler.pin(session.id, !session.pinned); onDismiss() },
            )
            SettingsRow(stringResource(R.string.common_delete), icon = ReiIcons.Trash, destructive = true, onClick = { dialog = "delete" })
        }
    }
}
