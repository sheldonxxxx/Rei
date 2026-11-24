package dev.rei.android.ui.components

import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The app-level snackbar. It lives in the shell, not in a screen, so a message such as "Moved to Trash · Undo" outlives
 * the viewer that raised it. [launch] runs work in the shell's scope for the same reason (the Undo call).
 */
class Notices(val host: SnackbarHostState, private val scope: CoroutineScope) {
    fun show(message: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
        scope.launch {
            host.currentSnackbarData?.dismiss()
            val result = host.showSnackbar(message, actionLabel, withDismissAction = actionLabel == null, duration = SnackbarDuration.Short)
            if (result == SnackbarResult.ActionPerformed) onAction?.invoke()
        }
    }

    fun launch(block: suspend CoroutineScope.() -> Unit) { scope.launch(block = block) }
}

val LocalNotices = staticCompositionLocalOf<Notices?> { null }
