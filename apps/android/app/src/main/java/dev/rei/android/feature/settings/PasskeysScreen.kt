package dev.rei.android.feature.settings

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.string
import dev.rei.android.passkeyError
import dev.rei.android.passkeyPath
import dev.rei.android.registerPasskey
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal data class SavedPasskey(val id: String, val label: String)

/** Passkeys: sign in with the device's screen lock. List, add (HTTPS only), rename and remove. */
@Composable
fun PasskeysScreen(api: ReiApi, onBack: () -> Unit) {
    val activity = LocalActivity.current
    val writes = rememberWrites()
    val keys = rememberResource(api) { api.request("GET", passkeyPath).objects("passkeys").map { SavedPasskey(it.string("id"), it.string("label")) } }
    val https = api.serverUrl.startsWith("https://")
    var adding by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<SavedPasskey?>(null) }
    var renaming by remember { mutableStateOf<SavedPasskey?>(null) }
    var removing by remember { mutableStateOf<SavedPasskey?>(null) }

    SubScreen(
        stringResource(R.string.settings_page_passkeys), onBack,
        busy = writes.busy || keys.loading,
        error = writes.error ?: keys.error,
        onRetry = keys::reload,
        actions = { ReiIconButton(ReiIcons.Plus, stringResource(R.string.settings_passkeys_add), { adding = true }, enabled = !writes.busy && activity != null && https) },
    ) {
        if (!https) StatusBanner(stringResource(R.string.settings_passkeys_https))
        val list = keys.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.Key, stringResource(R.string.settings_passkeys_empty_title), body = stringResource(R.string.settings_passkeys_empty_body))
            else -> SettingsGroup {
                list.forEachIndexed { index, key ->
                    SettingsRow(key.label, icon = ReiIcons.Key, onClick = { sheet = key }, dividerBelow = index < list.lastIndex, trailing = { SettingsChevron() })
                }
            }
        }
    }
    sheet?.let { key ->
        ReiSheet(onDismiss = { sheet = null }, title = key.label) {
            SettingsRow(stringResource(R.string.drawer_chat_rename), icon = ReiIcons.Edit, onClick = { sheet = null; renaming = key })
            SettingsRow(stringResource(R.string.settings_passkeys_remove), icon = ReiIcons.Trash, destructive = true, onClick = { sheet = null; removing = key })
        }
    }
    if (adding && activity != null) {
        NewPasskeyDialog(onDismiss = { adding = false }) { label, password ->
            adding = false
            writes.run(keys::reload) {
                try {
                    registerPasskey(activity, api, password, label)
                } catch (failure: Exception) {
                    if (failure is kotlinx.coroutines.CancellationException) throw failure
                    throw java.io.IOException(passkeyError(activity, failure))
                }
            }
        }
    }
    renaming?.let { key ->
        TextEditDialog(
            title = stringResource(R.string.settings_passkeys_rename_title), label = stringResource(R.string.settings_passkeys_name_label), initial = key.label, limit = 60,
            onDismiss = { renaming = null },
            onSave = { label ->
                renaming = null
                writes.run(keys::reload) { api.request("PATCH", passkeyPath + key.id, buildJsonObject { put("label", label) }) }
            },
        )
    }
    removing?.let { key ->
        ConfirmDialog(
            title = stringResource(R.string.settings_passkeys_remove_title),
            text = stringResource(R.string.settings_passkeys_remove_body, key.label),
            confirmLabel = stringResource(R.string.settings_passkeys_remove_action),
            destructive = true,
            onConfirm = { removing = null; writes.run(keys::reload) { api.request("DELETE", passkeyPath + key.id) } },
            onDismiss = { removing = null },
        )
    }
}

@Composable
private fun NewPasskeyDialog(onDismiss: () -> Unit, onConfirm: (label: String, password: String) -> Unit) {
    var label by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = ReiShapes.Dialog,
        containerColor = ReiTheme.colors.card,
        title = { Text(stringResource(R.string.settings_passkeys_add)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ReiTextField(label, { label = it.take(60) }, stringResource(R.string.settings_passkeys_name_optional))
                ReiTextField(
                    password, { password = it }, stringResource(R.string.settings_passkeys_password),
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    contentType = ContentType.Password,
                    trailingContent = {
                        ReiIconButton(
                            if (showPassword) ReiIcons.EyeOff else ReiIcons.Eye,
                            stringResource(if (showPassword) R.string.connect_hide_password else R.string.connect_show_password),
                            { showPassword = !showPassword },
                        )
                    },
                )
            }
        },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.common_cancel)) } },
        confirmButton = { TextButton(onClick = { onConfirm(label.trim(), password) }, enabled = password.isNotEmpty()) { Text(stringResource(R.string.common_continue)) } },
    )
}
