package dev.rei.android.feature.settings

import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.annotation.Keep
import androidx.annotation.StringRes
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import dev.rei.android.BuildConfig
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.feature.chat.ShowDetailsStore
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.ReiScreenPreviewSurface
import dev.rei.android.update.UpdateManager
import dev.rei.android.update.UpdateState
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.ThemePreference

/** The native settings sub-screens the index opens. */
@Keep
@kotlinx.serialization.Serializable
enum class SettingsPage(@StringRes val titleRes: Int) {
    General(R.string.settings_page_general),
    Appearance(R.string.settings_page_appearance),
    Notifications(R.string.settings_page_notifications),
    Devices(R.string.settings_page_devices),
    Passkeys(R.string.settings_page_passkeys),
    TwoFactor(R.string.settings_page_two_factor),
    Memory(R.string.settings_page_memory),
    Triggers(R.string.settings_page_triggers),
    Usage(R.string.settings_page_usage),
    Permissions(R.string.settings_page_permissions),
    Models(R.string.settings_page_models),
    Runtime(R.string.settings_page_runtime),
    Providers(R.string.settings_page_providers),
    Connectors(R.string.settings_page_connectors),
    Skills(R.string.settings_page_skills),
    Plugins(R.string.settings_page_plugins),
}

@Composable
internal fun SettingsIndex(
    api: ReiApi,
    serverUrl: String,
    themePreference: ThemePreference,
    onOpen: (SettingsPage) -> Unit,
    onSignOut: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val context = LocalContext.current
    val details = remember { ShowDetailsStore.get(context) }
    val showDetails by details.enabled.collectAsStateWithLifecycle()
    val device = rememberResource("settings.device", api) {
        api.request("GET", listOf("api", "devices")).objects("devices")
            .firstOrNull { it.optionalString("current") == "true" }?.string("label")
    }
    val updates = remember { UpdateManager.get(context) }
    val updateState by updates.state.collectAsStateWithLifecycle()
    val notices = LocalNotices.current
    androidx.compose.runtime.LaunchedEffect(updates, notices) {
        updates.messages.collect { notices?.show(it) }
    }
    SettingsIndexContent(
        serverUrl = serverUrl,
        deviceName = device.value,
        themePreference = themePreference,
        showDetails = showDetails,
        onShowDetails = details::set,
        updatesEnabled = updates.enabled,
        updateState = updateState,
        onCheckUpdates = updates::checkNow,
        onOpen = onOpen,
        onSignOut = onSignOut,
        onDisconnect = onDisconnect,
    )
}

@Composable
internal fun SettingsIndexContent(
    serverUrl: String,
    deviceName: String?,
    themePreference: ThemePreference,
    showDetails: Boolean,
    onShowDetails: (Boolean) -> Unit,
    updatesEnabled: Boolean,
    updateState: UpdateState,
    onCheckUpdates: () -> Unit,
    onOpen: (SettingsPage) -> Unit,
    onSignOut: () -> Unit,
    onDisconnect: () -> Unit,
) {
    var confirm by rememberSaveable { mutableStateOf<String?>(null) }
    val scroll = rememberScrollState()
    val scrolled by remember { derivedStateOf { scroll.value > 0 } }
    Column(Modifier.fillMaxSize()) {
        ReiTopBar("", scrolledTitle = stringResource(R.string.settings_title), scrolled = scrolled)
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .widthIn(max = 760.dp)
                    .fillMaxWidth()
                    .verticalScroll(scroll)
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(stringResource(R.string.settings_title), Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
                AccountCard(host = hostOf(serverUrl), device = deviceName)

                SettingsGroup(title = stringResource(R.string.settings_group_app)) {
                    SettingsRow(
                        stringResource(R.string.settings_page_appearance),
                        icon = ReiIcons.Eye,
                        summary = stringResource(themePreference.labelRes),
                        onClick = { onOpen(SettingsPage.Appearance) },
                        dividerBelow = true,
                        trailing = { SettingsChevron() },
                    )
                    SettingsRow(
                        stringResource(R.string.settings_page_notifications),
                        icon = ReiIcons.Bell,
                        onClick = { onOpen(SettingsPage.Notifications) },
                        dividerBelow = true,
                        trailing = { SettingsChevron() },
                    )
                    SettingsSwitchRow(
                        stringResource(R.string.settings_show_details), showDetails, onShowDetails,
                        icon = ReiIcons.Sliders, summary = stringResource(R.string.settings_show_details_summary),
                        dividerBelow = true,
                    )
                    SettingsRow(
                        stringResource(R.string.settings_check_updates), icon = ReiIcons.Download,
                        summary = updateSummary(updatesEnabled, updateState).asString(),
                        onClick = if (updatesEnabled) onCheckUpdates else null,
                    )
                }
                SettingsGroup(title = stringResource(R.string.settings_group_security)) {
                    SettingsRow(stringResource(R.string.settings_page_devices), icon = ReiIcons.Devices, summary = stringResource(R.string.settings_devices_summary), onClick = { onOpen(SettingsPage.Devices) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_passkeys), icon = ReiIcons.Key, summary = stringResource(R.string.settings_passkeys_summary), onClick = { onOpen(SettingsPage.Passkeys) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_two_factor), icon = ReiIcons.Lock, summary = stringResource(R.string.settings_two_factor_summary), onClick = { onOpen(SettingsPage.TwoFactor) }, trailing = { SettingsChevron() })
                }
                SettingsGroup(title = stringResource(R.string.settings_group_workspace)) {
                    SettingsRow(stringResource(R.string.settings_page_general), icon = ReiIcons.Settings, summary = stringResource(R.string.settings_general_summary), onClick = { onOpen(SettingsPage.General) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_memory), icon = ReiIcons.Memory, summary = stringResource(R.string.settings_memory_summary), onClick = { onOpen(SettingsPage.Memory) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_triggers), icon = ReiIcons.Clock, summary = stringResource(R.string.settings_triggers_summary), onClick = { onOpen(SettingsPage.Triggers) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_usage), icon = ReiIcons.Usage, summary = stringResource(R.string.settings_usage_summary), onClick = { onOpen(SettingsPage.Usage) }, trailing = { SettingsChevron() })
                }
                SettingsGroup(title = stringResource(R.string.settings_group_models_providers)) {
                    SettingsRow(stringResource(R.string.settings_page_models), icon = ReiIcons.Brain, summary = stringResource(R.string.settings_models_summary), onClick = { onOpen(SettingsPage.Models) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_providers), icon = ReiIcons.Globe, summary = stringResource(R.string.settings_providers_summary), onClick = { onOpen(SettingsPage.Providers) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_runtime), icon = ReiIcons.Terminal, summary = stringResource(R.string.settings_runtime_summary), onClick = { onOpen(SettingsPage.Runtime) }, trailing = { SettingsChevron() })
                }
                SettingsGroup(title = stringResource(R.string.settings_group_capabilities)) {
                    SettingsRow(stringResource(R.string.settings_page_permissions), icon = ReiIcons.Shield, summary = stringResource(R.string.settings_permissions_summary), onClick = { onOpen(SettingsPage.Permissions) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_connectors), icon = ReiIcons.Branch, summary = stringResource(R.string.settings_connectors_summary), onClick = { onOpen(SettingsPage.Connectors) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_skills), icon = ReiIcons.Sparkle, summary = stringResource(R.string.settings_skills_summary), onClick = { onOpen(SettingsPage.Skills) }, dividerBelow = true, trailing = { SettingsChevron() })
                    SettingsRow(stringResource(R.string.settings_page_plugins), icon = ReiIcons.Puzzle, summary = stringResource(R.string.settings_plugins_summary), onClick = { onOpen(SettingsPage.Plugins) }, trailing = { SettingsChevron() })
                }
                SettingsGroup(title = stringResource(R.string.settings_group_session)) {
                    SettingsRow(stringResource(R.string.settings_sign_out_row), icon = ReiIcons.Logout, onClick = { confirm = "signout" }, destructive = true, dividerBelow = true)
                    SettingsRow(stringResource(R.string.settings_disconnect_row), icon = ReiIcons.Close, onClick = { confirm = "disconnect" }, destructive = true)
                }
            }
        }
    }
    when (confirm) {
        "signout" -> ConfirmDialog(
            title = stringResource(R.string.settings_sign_out_confirm_title),
            text = stringResource(R.string.settings_sign_out_confirm_body),
            confirmLabel = stringResource(R.string.settings_sign_out_action),
            destructive = true,
            onConfirm = { confirm = null; onSignOut() },
            onDismiss = { confirm = null },
        )
        "disconnect" -> ConfirmDialog(
            title = stringResource(R.string.settings_disconnect_confirm_title),
            text = stringResource(R.string.settings_disconnect_confirm_body),
            confirmLabel = stringResource(R.string.settings_disconnect_action),
            destructive = true,
            onConfirm = { confirm = null; onDisconnect() },
            onDismiss = { confirm = null },
        )
    }
}

/** The current version, and what the update check found. */
internal fun updateSummary(enabled: Boolean, state: UpdateState, current: String = BuildConfig.VERSION_NAME): UiText {
    val status: UiText? = when {
        !enabled -> UiText.Resource(R.string.settings_update_disabled)
        else -> when (state) {
            UpdateState.Checking -> UiText.Resource(R.string.settings_update_checking)
            UpdateState.UpToDate -> UiText.Resource(R.string.settings_update_up_to_date)
            is UpdateState.Available, is UpdateState.NeedsPermission, is UpdateState.AwaitingPermission, is UpdateState.Failed ->
                UiText.Resource(R.string.settings_update_available)
            is UpdateState.Downloading, is UpdateState.Installing -> UiText.Resource(R.string.settings_update_updating)
            UpdateState.Idle -> null
        }
    }
    return if (status == null) UiText.Resource(R.string.settings_version, current) else UiText.Resource(R.string.settings_version_status, current, status)
}

/** The account header: the server's host and the name this device signed in with. */
@Composable
private fun AccountCard(host: String, device: String?) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = ReiShapes.Card,
        color = ReiTheme.colors.card,
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
                    if (device != null) stringResource(R.string.settings_signed_in_device, device) else stringResource(R.string.settings_signed_in_this_device),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                )
            }
        }
    }
}

internal fun hostOf(serverUrl: String): String = serverUrl.toUri().let { it.authority ?: serverUrl }

@ReiPreviews
@Composable
private fun SettingsIndexPreview() = ReiScreenPreviewSurface {
    SettingsIndexContent(
        serverUrl = "https://rei.example.com",
        deviceName = "Pixel 9",
        themePreference = ThemePreference.System,
        showDetails = false,
        onShowDetails = {},
        updatesEnabled = true,
        updateState = UpdateState.UpToDate,
        onCheckUpdates = {},
        onOpen = {},
        onSignOut = {},
        onDisconnect = {},
    )
}
