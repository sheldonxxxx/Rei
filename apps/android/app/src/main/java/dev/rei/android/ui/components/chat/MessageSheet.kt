package dev.rei.android.ui.components.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.Message
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons

/** What a long press on a message can do. A null action is not offered. */
@Immutable
data class MessageSheetActions(
    val onCopy: () -> Unit,
    val onSelectText: () -> Unit,
    val onEdit: (() -> Unit)?,
    val onRetry: (() -> Unit)?,
    val onFork: (() -> Unit)?,
    val onSwitchVersion: ((next: Boolean) -> Unit)?,
)

/** The long-press sheet: Copy, Select text, then Edit, Retry and Fork where they apply, and `‹ 2/3 ›` for edited messages. */
@Composable
fun MessageSheet(message: Message, actions: MessageSheetActions, onDismiss: () -> Unit) {
    ReiSheet(onDismiss = onDismiss) {
        message.versions?.let { versions ->
            actions.onSwitchVersion?.let { switch ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(stringResource(R.string.chat_msg_version_title), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ReiIconButton(ReiIcons.Back, stringResource(R.string.chat_msg_version_prev), { switch(false) }, enabled = versions.index > 1)
                        val versionDesc = stringResource(R.string.chat_msg_version_of, versions.index, versions.count)
                        Text(
                            stringResource(R.string.chat_msg_version_ratio, versions.index, versions.count),
                            Modifier.semantics { contentDescription = versionDesc },
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        ReiIconButton(ReiIcons.Forward, stringResource(R.string.chat_msg_version_next), { switch(true) }, enabled = versions.index < versions.count)
                    }
                }
            }
        }
        SettingsRow(stringResource(R.string.common_copy), icon = ReiIcons.Copy, onClick = actions.onCopy)
        SettingsRow(stringResource(R.string.drawer_select_text), icon = ReiIcons.Pointer, onClick = actions.onSelectText)
        actions.onEdit?.let { SettingsRow(stringResource(R.string.common_edit), icon = ReiIcons.Edit, onClick = it) }
        actions.onRetry?.let { SettingsRow(stringResource(R.string.common_retry), icon = ReiIcons.Reload, onClick = it) }
        actions.onFork?.let { SettingsRow(stringResource(R.string.drawer_chat_fork), icon = ReiIcons.Branch, onClick = it) }
    }
}

/** The whole message as selectable text, for when a long press on the bubble opens the sheet instead of selecting. */
@Composable
fun SelectTextSheet(text: String, onDismiss: () -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.drawer_select_text)) {
        SelectionContainer {
            Text(
                text,
                Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

/** Editing your own message runs it again from that point, as a new version. */
@Composable
fun EditMessageSheet(initial: String, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.chat_msg_edit_title)) {
        Column(Modifier.padding(horizontal = 24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ReiTextField(
                value = text,
                onValueChange = { text = it },
                label = stringResource(R.string.chat_msg_edit_label),
                singleLine = false,
                minLines = 3,
                maxLines = 8,
            )
            Text(
                stringResource(R.string.chat_msg_edit_note),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = { onSend(text.trim()) },
                enabled = text.isNotBlank() && text.length <= 32_000,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.chat_msg_edit_send)) }
        }
    }
}
