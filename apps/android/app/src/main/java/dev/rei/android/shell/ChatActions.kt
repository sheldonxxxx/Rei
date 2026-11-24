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
import androidx.compose.ui.unit.dp
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
            title = { Text("Rename chat") },
            text = { ReiTextField(title, { title = it }, "Chat title") },
            dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
            confirmButton = {
                TextButton(
                    onClick = { handler.rename(session.id, title.trim()); onDismiss() },
                    enabled = title.isNotBlank(),
                ) { Text("Save") }
            },
        )
        "delete" -> ConfirmDialog(
            title = "Delete this chat?",
            text = "This removes the conversation and its searchable history. It can’t be undone.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = { handler.delete(session.id); onDismiss() },
            onDismiss = onDismiss,
        )
        else -> ReiSheet(onDismiss = onDismiss, title = session.title.ifBlank { "Untitled chat" }) {
            SettingsRow("Rename", icon = ReiIcons.Edit, onClick = { dialog = "rename" })
            SettingsRow(
                if (session.pinned) "Unpin" else "Pin",
                icon = ReiIcons.Pin,
                onClick = { handler.pin(session.id, !session.pinned); onDismiss() },
            )
            SettingsRow("Delete", icon = ReiIcons.Trash, destructive = true, onClick = { dialog = "delete" })
        }
    }
}
