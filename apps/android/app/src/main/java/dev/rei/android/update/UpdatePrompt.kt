package dev.rei.android.update

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.rei.android.BuildConfig
import dev.rei.android.R
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind

/**
 * The update flow's UI, shown over everything (including the connect screen, where a 426 sends people who need an update):
 * a dialog to offer the update or to ask for the install permission, a banner while it downloads and installs, and a dialog
 * with "Try again" when it fails.
 */
@Composable
fun UpdatePrompt(modifier: Modifier = Modifier, showBanner: Boolean = true) {
    val context = LocalContext.current
    val manager = remember(context) { UpdateManager.get(context) }
    val state by manager.state.collectAsStateWithLifecycle()
    when (val current = state) {
        is UpdateState.Available -> ConfirmDialog(
            title = stringResource(R.string.update_dialog_title),
            text = buildString {
                append(stringResource(R.string.update_dialog_version, current.feed.versionName, BuildConfig.VERSION_NAME))
                if (current.feed.notes.isNotBlank()) append("\n\n").append(current.feed.notes.trim())
            },
            confirmLabel = stringResource(R.string.update_action_update),
            dismissLabel = stringResource(R.string.update_action_later),
            onConfirm = manager::confirm,
            onDismiss = manager::dismiss,
        )
        is UpdateState.NeedsPermission -> ConfirmDialog(
            title = stringResource(R.string.update_permission_title),
            text = stringResource(R.string.update_permission_body),
            confirmLabel = stringResource(R.string.update_permission_open_settings),
            onConfirm = manager::openInstallSettings,
            onDismiss = manager::dismiss,
        )
        is UpdateState.Failed -> ConfirmDialog(
            title = stringResource(R.string.update_failed_title),
            text = current.message,
            confirmLabel = stringResource(R.string.common_try_again),
            dismissLabel = stringResource(R.string.common_close),
            onConfirm = manager::confirm,
            onDismiss = manager::dismiss,
        )
        else -> Unit
    }
    if (showBanner) {
        UpdateBanner(modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 12.dp, vertical = 8.dp))
    }
}

/** Progress banner for an active download/install, docked under `ReiTopBar` inside the signed-in shell. */
@Composable
fun UpdateBanner(modifier: Modifier = Modifier) {
    if (LocalInspectionMode.current) return
    val context = LocalContext.current
    val manager = remember(context) { UpdateManager.get(context) }
    val state by manager.state.collectAsStateWithLifecycle()
    val progress = when (val current = state) {
        is UpdateState.Downloading -> {
            val pct = current.percent
            if (pct != null) stringResource(R.string.update_banner_downloading, current.feed.versionName, pct)
            else stringResource(R.string.update_banner_downloading_indeterminate, current.feed.versionName)
        }
        is UpdateState.Installing ->
            if (current.confirming) stringResource(R.string.update_banner_confirm)
            else stringResource(R.string.update_banner_installing, current.feed.versionName)
        else -> null
    }
    if (progress != null) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            val installing = state is UpdateState.Installing
            StatusBanner(
                progress,
                kind = if ((state as? UpdateState.Installing)?.confirming == true) StatusKind.Attention else StatusKind.Info,
                actionLabel = if (installing) stringResource(R.string.common_cancel) else null,
                onAction = if (installing) manager::cancelInstall else null,
            )
        }
    }
}
