package dev.rei.android.feature.settings

import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import dev.rei.android.BuildConfig
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.feature.chat.ShowDetailsStore
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.update.UpdateManager
import dev.rei.android.update.UpdateState
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ThemePreference

/** The native settings sub-screens the index opens. */
@kotlinx.serialization.Serializable
enum class SettingsPage(val title: String) {
    General("General"),
    Appearance("Appearance"),
    Notifications("Notifications"),
    Devices("Devices"),
    Passkeys("Passkeys"),
    Memory("Memory"),
    Triggers("Triggers"),
    Usage("Usage"),
    Permissions("Permissions"),
    Models("Models"),
    Runtime("Runtime"),
    Providers("Providers"),
    Connectors("Connectors"),
    Skills("Skills"),
    Plugins("Plugins"),
}

@Composable
internal fun SettingsIndex(
    api: ReiApi,
    serverUrl: String,
    themePreference: ThemePreference,
    onOpen: (SettingsPage) -> Unit,
    onSignOut: () -> Unit,
    onDisconnect: () -> Unit,
    scroll: ScrollState = rememberScrollState(),
) {
    val context = LocalContext.current
    val details = remember { ShowDetailsStore.get(context) }
    val showDetails by details.enabled.collectAsStateWithLifecycle()
    val device = rememberResource(api) {
        api.request("GET", listOf("api", "devices")).objects("devices")
            .firstOrNull { it.optionalString("current") == "true" }?.string("label")
    }
    var confirm by rememberSaveable { mutableStateOf<String?>(null) }
    val updates = remember { UpdateManager.get(context) }
    val updateState by updates.state.collectAsStateWithLifecycle()
    val notices = LocalNotices.current
    androidx.compose.runtime.LaunchedEffect(updates, notices) {
        updates.messages.collect { notices?.show(it) }
    }
    Column(Modifier.fillMaxSize()) {
        ReiTopBar("", scrolled = scroll.value > 0)
        Column(
            Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 16.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Settings", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
            AccountCard(host = hostOf(serverUrl), device = device.value)

            SettingsGroup(title = "App") {
                SettingsRow("Appearance", icon = ReiIcons.Eye, summary = themePreference.label, onClick = { onOpen(SettingsPage.Appearance) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Notifications", icon = ReiIcons.Bell, onClick = { onOpen(SettingsPage.Notifications) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsSwitchRow(
                    "Show details by default", showDetails, details::set,
                    icon = ReiIcons.Info, summary = "Chats show full tool arguments and results.",
                    dividerBelow = true,
                )
                SettingsRow(
                    "Check for updates", icon = ReiIcons.Download,
                    summary = updateSummary(updates.enabled, updateState),
                    onClick = if (updates.enabled) updates::checkNow else null,
                )
            }
            SettingsGroup(title = "Security") {
                SettingsRow("Devices", icon = ReiIcons.Keyboard, summary = "Where you’re signed in", onClick = { onOpen(SettingsPage.Devices) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Passkeys", icon = ReiIcons.Key, onClick = { onOpen(SettingsPage.Passkeys) }, trailing = { SettingsChevron() })
            }
            SettingsGroup(title = "Rei") {
                SettingsRow("General", icon = ReiIcons.Settings, onClick = { onOpen(SettingsPage.General) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Memory", icon = ReiIcons.Memory, onClick = { onOpen(SettingsPage.Memory) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Triggers", icon = ReiIcons.Clock, onClick = { onOpen(SettingsPage.Triggers) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Usage", icon = ReiIcons.Usage, onClick = { onOpen(SettingsPage.Usage) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Permissions", icon = ReiIcons.Shield, onClick = { onOpen(SettingsPage.Permissions) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Providers", icon = ReiIcons.Globe, onClick = { onOpen(SettingsPage.Providers) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Models", icon = ReiIcons.Brain, onClick = { onOpen(SettingsPage.Models) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Runtime", icon = ReiIcons.Terminal, onClick = { onOpen(SettingsPage.Runtime) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Connectors", icon = ReiIcons.Branch, onClick = { onOpen(SettingsPage.Connectors) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Skills", icon = ReiIcons.Sparkle, onClick = { onOpen(SettingsPage.Skills) }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Plugins", icon = ReiIcons.Puzzle, onClick = { onOpen(SettingsPage.Plugins) }, trailing = { SettingsChevron() })
            }
            SettingsGroup(title = "Session") {
                SettingsRow("Sign out of this device", icon = ReiIcons.Logout, onClick = { confirm = "signout" }, destructive = true, dividerBelow = true)
                SettingsRow("Disconnect server", icon = ReiIcons.Close, onClick = { confirm = "disconnect" }, destructive = true)
            }
        }
    }
    when (confirm) {
        "signout" -> ConfirmDialog(
            title = "Sign out of this device?",
            text = "This device loses access to Rei until you sign in again. Your chats, files and memory stay on the server.",
            confirmLabel = "Sign out",
            destructive = true,
            onConfirm = { confirm = null; onSignOut() },
            onDismiss = { confirm = null },
        )
        "disconnect" -> ConfirmDialog(
            title = "Disconnect from this server?",
            text = "This signs this device out and forgets the server address. Your chats, files and memory stay on the server. You’ll need the address to connect again.",
            confirmLabel = "Disconnect",
            destructive = true,
            onConfirm = { confirm = null; onDisconnect() },
            onDismiss = { confirm = null },
        )
    }
}

/** The current version, and what the update check found. */
internal fun updateSummary(enabled: Boolean, state: UpdateState, current: String = BuildConfig.VERSION_NAME): String {
    val status = when {
        !enabled -> "Update checks are off in this build"
        else -> when (state) {
            UpdateState.Checking -> "Checking…"
            UpdateState.UpToDate -> "Up to date"
            is UpdateState.Available, is UpdateState.NeedsPermission, is UpdateState.AwaitingPermission, is UpdateState.Failed ->
                "Update available"
            is UpdateState.Downloading, is UpdateState.Installing -> "Updating…"
            UpdateState.Idle -> null
        }
    }
    return if (status == null) "Version $current" else "Version $current · $status"
}

/** The account header: the server's host and the name this device signed in with. */
@Composable
private fun AccountCard(host: String, device: String?) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = ReiShapes.Card,
        color = colors.surfaceContainerLowest,
        border = BorderStroke(1.dp, colors.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Surface(shape = ReiShapes.Pill, color = colors.surfaceContainerHighest, modifier = Modifier.size(48.dp)) {
                Icon(ReiIcons.Globe, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.padding(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(host, style = MaterialTheme.typography.titleMedium, maxLines = 2)
                Text(
                    if (device != null) "Signed in on $device" else "Signed in on this device",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                )
            }
        }
    }
}

internal fun hostOf(serverUrl: String): String = serverUrl.toUri().let { it.authority ?: serverUrl }
