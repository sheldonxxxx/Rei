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
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.rei.android.BuildConfig
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
            title = "Update Rei",
            text = buildString {
                append("Version ${current.feed.versionName} is available. You have ${BuildConfig.VERSION_NAME}.")
                if (current.feed.notes.isNotBlank()) append("\n\n").append(current.feed.notes.trim())
            },
            confirmLabel = "Update",
            dismissLabel = "Later",
            onConfirm = manager::confirm,
            onDismiss = manager::dismiss,
        )
        is UpdateState.NeedsPermission -> ConfirmDialog(
            title = "Allow Rei to install updates",
            text = "Rei is not on Google Play, so Android asks you to allow it to install its own updates. " +
                "Open the settings page, turn on Allow from this source, then come back to Rei to finish.",
            confirmLabel = "Open settings",
            onConfirm = manager::openInstallSettings,
            onDismiss = manager::dismiss,
        )
        is UpdateState.Failed -> ConfirmDialog(
            title = "Update failed",
            text = current.message,
            confirmLabel = "Try again",
            dismissLabel = "Close",
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
    val context = LocalContext.current
    val manager = remember(context) { UpdateManager.get(context) }
    val state by manager.state.collectAsStateWithLifecycle()
    val progress = when (val current = state) {
        is UpdateState.Downloading -> "Downloading Rei ${current.feed.versionName}" + (current.percent?.let { " · $it%" } ?: "…")
        is UpdateState.Installing ->
            if (current.confirming) "Confirm the update in the Android installer to finish."
            else "Installing Rei ${current.feed.versionName}…"
        else -> null
    }
    if (progress != null) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            val installing = state is UpdateState.Installing
            StatusBanner(
                progress,
                kind = if ((state as? UpdateState.Installing)?.confirming == true) StatusKind.Attention else StatusKind.Info,
                actionLabel = if (installing) "Cancel" else null,
                onAction = if (installing) manager::cancelInstall else null,
            )
        }
    }
}
