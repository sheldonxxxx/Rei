package dev.rei.android.feature.settings

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.rei.android.R
import dev.rei.android.ReiFirebase
import dev.rei.android.ReiNotifications
import dev.rei.android.data.ReiApi
import dev.rei.android.data.optionalString
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Notifications: this device's push switch, whether previews show message text, a test, and Android's own settings. */
@Composable
fun NotificationsScreen(api: ReiApi, onBack: () -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext
    val configured = ReiFirebase.configured(app)
    val path = listOf("api", "notifications")
    val writes = rememberWrites()
    var enabled by remember { mutableStateOf(ReiNotifications.enabled(app)) }
    var permitted by remember(app) { mutableStateOf(ReiNotifications.hasPermission(app)) }
    var notice by remember { mutableStateOf<UiText?>(null) }
    val preview = rememberResource("notifications.preview", api) { api.request("GET", path).optionalString("preview") == "true" }

    fun update(value: Boolean) {
        ReiNotifications.setEnabled(app, value)
        enabled = value
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permitted = ReiNotifications.hasPermission(app)
        if (granted) update(true) else notice = UiText.Resource(R.string.settings_notif_perm_off)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        val allowed = ReiNotifications.hasPermission(app)
        if (allowed != permitted) notice = null
        permitted = allowed
    }

    SubScreen(stringResource(R.string.settings_page_notifications), onBack, busy = writes.busy || preview.loading, error = writes.error ?: preview.error, onRetry = preview::reload) {
        SettingsGroup {
            SettingsSwitchRow(
                stringResource(R.string.settings_notif_android), enabled,
                { value ->
                    notice = null
                    when {
                        !value -> update(false)
                        permitted -> update(true)
                        Build.VERSION.SDK_INT >= 33 -> permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else -> notice = UiText.Resource(R.string.settings_notif_allow_settings)
                    }
                },
                icon = ReiIcons.Bell,
                summary = stringResource(if (configured) R.string.settings_notif_enabled_summary else R.string.settings_notif_no_firebase),
                enabled = configured,
                dividerBelow = true,
            )
            SettingsSwitchRow(
                stringResource(R.string.settings_notif_previews), preview.value == true,
                { value ->
                    writes.run {
                        val result = api.request("PUT", path + "preview", buildJsonObject { put("preview", value) })
                        preview.set(result.optionalString("preview") == "true")
                    }
                },
                icon = ReiIcons.Eye,
                summary = stringResource(R.string.settings_notif_previews_summary),
                enabled = preview.value != null && !writes.busy,
                dividerBelow = configured,
            )
            if (configured && enabled) {
                SettingsRow(
                    stringResource(R.string.settings_notif_test), icon = ReiIcons.Send,
                    onClick = { if (!writes.busy) writes.run({ notice = UiText.Resource(R.string.settings_notif_test_sent) }) { api.request("POST", path + "test") } },
                    dividerBelow = !permitted,
                )
            }
            if (configured && !permitted) {
                SettingsRow(
                    stringResource(R.string.settings_notif_android_settings), icon = ReiIcons.Settings,
                    summary = stringResource(R.string.settings_notif_android_off_summary),
                    onClick = {
                        try {
                            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                        } catch (_: ActivityNotFoundException) {
                            notice = UiText.Resource(R.string.settings_notif_open_settings_hint)
                        }
                    },
                    trailing = { SettingsChevron() },
                )
            }
        }
        notice?.asString()?.let { StatusBanner(it) }
    }
}
