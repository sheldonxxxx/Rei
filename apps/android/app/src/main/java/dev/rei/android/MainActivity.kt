package dev.rei.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.connect.ConnectScreen
import dev.rei.android.shell.ReiApp
import dev.rei.android.shell.ShellViewModel
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.ThemePreference
import dev.rei.android.update.UpdatePrompt
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val container by lazy { (application as ReiApplication).container }
    private val model: ReiViewModel by viewModels()
    private val shell: ShellViewModel by viewModels { ShellViewModel.factory(container) }
    private val chat: ChatViewModel by viewModels { ChatViewModel.factory(container) }

    private var splashReady = false
    private val splashTimeout = Runnable { splashReady = true }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        model.handleNotificationIntent(intent)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Hold the splash until the saved sign-in has been checked, so the connect screen never flashes before the chat.
        // An unreachable server must not hold it for long, so it also gives up after a moment.
        splash.setKeepOnScreenCondition { !splashReady }
        window.decorView.postDelayed(splashTimeout, 1500)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                model.state.collect { state ->
                    if (!state.restoring) splashReady = true
                }
            }
        }
        if (savedInstanceState == null) {
            model.handleNotificationIntent(intent)
            container.updateManager.checkAtLaunch()
        }
        val preference = container.themePreferenceStore.preference
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            val api by model.api.collectAsStateWithLifecycle()
            val pendingNotification by model.pendingNotification.collectAsStateWithLifecycle()
            val theme by preference.collectAsStateWithLifecycle(ThemePreference.System)
            ReiTheme(theme) {
                Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                    when {
                        // Keep the canvas blank while restoring cold-start auth so ConnectScreen never flashes
                        // and ReiApp's saved state is never torn down prematurely.
                        state.restoring -> Unit
                        state.signedIn && api != null -> ReiApp(
                            state = state,
                            api = api!!,
                            container = container,
                            chat = chat,
                            shell = shell,
                            notificationTarget = pendingNotification,
                            onOpenNotification = model::openNotification,
                            onSignOut = model::signOut,
                            onDisconnect = model::disconnect,
                        )
                        else -> ConnectScreen(state, model::connect, model::signIn, model::disconnect, onPasskey = model::signInWithPasskey)
                    }
                    // Over both, so update dialogs always work; while signed in, the progress banner docks below ReiTopBar.
                    UpdatePrompt(Modifier.align(Alignment.TopCenter), showBanner = !(state.signedIn && api != null))
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        model.foreground(true)
        container.updateManager.onForeground()
    }

    override fun onStop() {
        container.updateManager.onBackground()
        model.foreground(false)
        super.onStop()
    }

    override fun onDestroy() {
        window.decorView.removeCallbacks(splashTimeout)
        super.onDestroy()
    }
}
