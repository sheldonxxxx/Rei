package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A signed-in device as the server lists it. */
internal data class DeviceItem(val id: String, val label: String, val kind: String, val current: Boolean, val lastSeenAt: Long?)

/** Devices: where you are signed in. The current one is marked; rename or revoke through the row's sheet. */
@Composable
fun DevicesScreen(api: ReiApi, onCurrentRevoked: () -> Unit, onBack: () -> Unit) {
    val path = listOf("api", "devices")
    val writes = rememberWrites()
    val devices = rememberResource(api) {
        api.request("GET", path).objects("devices").map {
            DeviceItem(it.string("id"), it.string("label"), it.string("kind"), it.optionalString("current") == "true", it.optionalString("lastSeenAt")?.toLongOrNull())
        }
    }
    var sheet by remember { mutableStateOf<DeviceItem?>(null) }
    var renaming by remember { mutableStateOf<DeviceItem?>(null) }
    var revoking by remember { mutableStateOf<DeviceItem?>(null) }

    SubScreen("Devices", onBack, busy = writes.busy || devices.loading, error = writes.error ?: devices.error, onRetry = devices::reload) {
        val list = devices.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.Keyboard, "No devices", body = "Devices you sign in on appear here.")
            else -> SettingsGroup {
                list.forEachIndexed { index, device ->
                    SettingsRow(
                        title = device.label,
                        icon = ReiIcons.Devices,
                        summary = listOfNotNull(device.kind, dateTime(device.lastSeenAt)).joinToString(" · "),
                        onClick = { sheet = device },
                        dividerBelow = index < list.lastIndex,
                        trailing = {
                            if (device.current) Text("This device", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 4.dp))
                            SettingsChevron()
                        },
                    )
                }
            }
        }
    }
    sheet?.let { device ->
        ReiSheet(onDismiss = { sheet = null }, title = device.label) {
            SettingsRow("Rename", icon = ReiIcons.Edit, onClick = { sheet = null; renaming = device })
            SettingsRow("Revoke", icon = ReiIcons.Trash, destructive = true, onClick = { sheet = null; revoking = device })
        }
    }
    renaming?.let { device ->
        TextEditDialog(
            title = "Rename device", label = "Device name", initial = device.label, limit = 60,
            onDismiss = { renaming = null },
            onSave = { value ->
                renaming = null
                writes.run(devices::reload) { api.request("PATCH", path + device.id, buildJsonObject { put("label", value) }) }
            },
        )
    }
    revoking?.let { device ->
        ConfirmDialog(
            title = "Revoke ${device.label}?",
            text = if (device.current) "This is the device you’re using. It’s signed out and its notification channels are removed."
            else "${device.label} is signed out and its notification channels are removed. It can sign in again later.",
            confirmLabel = "Revoke",
            destructive = true,
            onConfirm = {
                revoking = null
                writes.run({ if (device.current) onCurrentRevoked() else devices.reload() }) { api.request("DELETE", path + device.id) }
            },
            onDismiss = { revoking = null },
        )
    }
}
