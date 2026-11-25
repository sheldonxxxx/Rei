package dev.rei.android.ui.components

import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect

/**
 * Keeps the window out of screenshots, screen recordings and the recent-apps thumbnail while [enabled] is true and this is
 * on screen (FLAG_SECURE). Use it where a secret is displayed, such as an authenticator key.
 */
@Composable
fun SecureWindow(enabled: Boolean = true) {
    val window = LocalActivity.current?.window
    DisposableEffect(window, enabled) {
        val applied = enabled && window != null && window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0
        if (applied) window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { if (applied) window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
}
