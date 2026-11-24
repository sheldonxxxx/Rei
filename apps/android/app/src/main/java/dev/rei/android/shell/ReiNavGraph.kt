package dev.rei.android.shell

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import dev.rei.android.ReiUiState
import dev.rei.android.ReiViewModel
import dev.rei.android.data.ReiApi
import dev.rei.android.feature.activity.ActivityScreen
import dev.rei.android.feature.chat.ChatScreen
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.knowledge.KnowledgeScreen
import dev.rei.android.feature.library.LibraryScreen
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.feature.settings.SettingsScreen
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiMotion

/**
 * What a destination may use. Phases 2 to 4 replace the legacy screens below with feature-package screens that read the same
 * environment, so a destination never has to find its own view model or the nav controller.
 */
class ShellEnv(
    val state: ReiUiState,
    val api: ReiApi,
    /** Session, sign-in and the chat catalog. */
    val model: ReiViewModel,
    /** The open chat's conversation. */
    val chat: ChatViewModel,
    val shell: ShellViewModel,
    val motionScale: Float,
    /** False while something (the live browser) covers the chat, so its streams rest. */
    val chatActive: Boolean,
    val onOpenBrowser: (sessionId: String) -> Unit,
    /** A settings page another screen asked for; cleared by [onSettingsTargetShown] once Settings has opened it. */
    val settingsTarget: SettingsPage? = null,
    val onSettingsTargetShown: () -> Unit = {},
)

/**
 * The destination registry. One line per destination: adding a screen to the shell is a [Destination] entry plus a
 * `destination(Destination.X, env) { ... }` line here. Every destination fades in (a screen is punctuation, not travel)
 * and out faster, and shows no motion at all under an animator scale of 0.
 */
@Composable
fun ReiNavHost(nav: NavHostController, env: ShellEnv, modifier: Modifier = Modifier) {
    val scale = env.motionScale
    NavHost(
        navController = nav,
        startDestination = Destination.Chat.route,
        modifier = modifier,
        enterTransition = { ReiMotion.enter(ReiEnter.Fade, scale) },
        exitTransition = { ReiMotion.exit(scale) },
        popEnterTransition = { ReiMotion.enter(ReiEnter.Fade, scale) },
        popExitTransition = { ReiMotion.exit(scale) },
    ) {
        destination(Destination.Chat, env) { ChatDestination(it) }
        destination(Destination.Library, env) { LibraryDestination(it) }
        destination(Destination.Knowledge, env) { KnowledgeDestination(it) }
        destination(Destination.Activity, env) { ActivityDestination(it) }
        destination(Destination.Settings, env) { SettingsDestination(it) }
        destination(Destination.Search, env) { HistorySearchScreen(it.shell, onOpened = LocalShell.current::showChat) }
    }
}

private fun NavGraphBuilder.destination(
    destination: Destination,
    env: ShellEnv,
    content: @Composable (ShellEnv) -> Unit,
) = composable(destination.route) { content(env) }

/** The chat: the open conversation under the shell's top bar and drawer. */
@Composable
private fun ChatDestination(env: ShellEnv) {
    val context: Context = LocalContext.current
    ChatScreen(
        api = env.api,
        sessionId = env.state.sessionId,
        historyLoaded = env.state.historyLoaded,
        chat = env.chat,
        active = env.chatActive,
        onOpenBrowser = { env.state.sessionId?.let(env.onOpenBrowser) },
    )
}

/** Library: the file grid; a card opens the full-screen viewer the shell hosts. */
@Composable
private fun LibraryDestination(env: ShellEnv) {
    val opener = LocalWorkspaceOpener.current
    LibraryScreen(env.model, env.api) { opener?.openFile(it.id) }
}

/** Knowledge: the page list; a row opens the page view and "New page" an empty editor, both hosted by the shell. */
@Composable
private fun KnowledgeDestination(env: ShellEnv) {
    val opener = LocalWorkspaceOpener.current
    KnowledgeScreen(env.model, onOpenPage = { opener?.openPage(it) }, onNewPage = { opener?.newPage() })
}

/** Background Activity: approvals and failures, running work and finished reports. A row opens its chat. */
@Composable
private fun ActivityDestination(env: ShellEnv) {
    val shell = LocalShell.current
    ActivityScreen(
        store = env.shell.activity,
        onDecide = { approval, approve, length, hours -> env.api.decideApproval(approval.id, approve, length, hours) },
        onOpenChat = { env.shell.openChat(it); shell.showChat() },
    )
}

/** Settings: the grouped index and its native sub-screens (Appearance, Notifications, Devices, Passkeys, Memory, Triggers, Usage). */
@Composable
private fun SettingsDestination(env: ShellEnv) {
    val shell = LocalShell.current
    val theme by env.shell.themePreference.collectAsStateWithLifecycle()
    SettingsScreen(
        api = env.api,
        serverUrl = env.state.serverUrl,
        themePreference = theme,
        onThemePreference = env.shell::setThemePreference,
        onSignOut = env.model::signOut,
        onDisconnect = env.model::disconnect,
        onOpenActivity = { shell.navigateTo(Destination.Activity) },
        target = env.settingsTarget,
        onTargetShown = env.onSettingsTargetShown,
    )
}
