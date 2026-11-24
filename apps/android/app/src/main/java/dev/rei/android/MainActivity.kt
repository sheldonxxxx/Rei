package dev.rei.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.connect.ConnectScreen
import dev.rei.android.shell.ReiApp
import dev.rei.android.shell.ShellViewModel
import dev.rei.android.update.UpdateManager
import dev.rei.android.update.UpdatePrompt
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.ThemePreferenceStore

class MainActivity : ComponentActivity() {
    private var notificationTarget by mutableStateOf<NotificationTarget?>(null)
    private var ready = false

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        notificationTarget = ReiNotifications.open(this, intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        // Hold the splash until the saved sign-in has been checked, so the connect screen never flashes before the chat.
        // An unreachable server must not hold it for long, so it also gives up after a moment.
        splash.setKeepOnScreenCondition { !ready }
        window.decorView.postDelayed({ ready = true }, 1500)
        if (savedInstanceState == null) {
            notificationTarget = ReiNotifications.open(this, intent)
            UpdateManager.get(this).checkAtLaunch()
        }
        val preference = ThemePreferenceStore.get(this).preference
        setContent {
            val model: ReiViewModel = viewModel()
            val shell: ShellViewModel = viewModel(factory = ShellViewModel.factory(model))
            val chat: ChatViewModel = viewModel(factory = ChatViewModel.factory(model))
            val state by model.state.collectAsStateWithLifecycle()
            if (!state.restoring) ready = true
            ReiTheme(preference.collectAsState().value) {
                Box(Modifier.fillMaxSize()) {
                    if (state.api != null) ReiApp(state, model, chat, shell, notificationTarget) { notificationTarget = null }
                    else ConnectScreen(state, model::connect, model::signIn, model::disconnect, model::signInWithPasskey)
                    // Over both, so an update can be offered from the connect screen, where an outdated app lands.
                    UpdatePrompt(Modifier.align(Alignment.TopCenter))
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        ViewModelProvider(this)[ReiViewModel::class.java].foreground(true)
        UpdateManager.get(this).onForeground()
    }

    override fun onStop() {
        UpdateManager.get(this).onBackground()
        ViewModelProvider(this)[ReiViewModel::class.java].foreground(false)
        super.onStop()
    }
}
