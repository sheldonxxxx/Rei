package dev.rei.android.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import dev.rei.android.BrowserScreen
import dev.rei.android.ReiUiState
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.feature.activity.ActivityScreen
import dev.rei.android.feature.chat.ChatScreen
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.knowledge.KnowledgePageScreen
import dev.rei.android.feature.knowledge.KnowledgeScreen
import dev.rei.android.feature.library.LibraryScreen
import dev.rei.android.feature.settings.AppearanceScreen
import dev.rei.android.feature.settings.ChatProvidersScreen
import dev.rei.android.feature.settings.ConnectorDetail
import dev.rei.android.feature.settings.ConnectorsScreen
import dev.rei.android.feature.settings.DevicesScreen
import dev.rei.android.feature.settings.EmbeddingScreen
import dev.rei.android.feature.settings.GeneralScreen
import dev.rei.android.feature.settings.MemoryHistory
import dev.rei.android.feature.settings.MemoryScreen
import dev.rei.android.feature.settings.ModelsScreen
import dev.rei.android.feature.settings.NotificationsScreen
import dev.rei.android.feature.settings.PasskeysScreen
import dev.rei.android.feature.settings.PermissionsScreen
import dev.rei.android.feature.settings.PluginDetailScreen
import dev.rei.android.feature.settings.PluginEditScreen
import dev.rei.android.feature.settings.PluginsScreen
import dev.rei.android.feature.settings.ProviderEditorScreen
import dev.rei.android.feature.settings.ProviderSection
import dev.rei.android.feature.settings.ProvidersScreen
import dev.rei.android.feature.settings.RuntimeScreen
import dev.rei.android.feature.settings.SandboxNetworkScreen
import dev.rei.android.feature.settings.SearchProvidersScreen
import dev.rei.android.feature.settings.SettingsIndex
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.feature.settings.SkillDetailScreen
import dev.rei.android.feature.settings.SkillsScreen
import dev.rei.android.feature.settings.TriggerDetail
import dev.rei.android.feature.settings.TriggersScreen
import dev.rei.android.feature.settings.TwoFactorScreen
import dev.rei.android.feature.settings.UsageScreen
import dev.rei.android.feature.viewer.FileViewerScreen
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiMotion

/**
 * What the navigation graph needs from the shell. Kept small and decoupled from `ReiViewModel`.
 */
class ShellEnv(
    val state: ReiUiState,
    val api: ReiApi,
    val container: AppContainer,
    /** The open chat's conversation. */
    val chat: ChatViewModel,
    val shell: ShellViewModel,
    val motionScale: Float,
    /** False while something (the browser, viewer, or another destination) covers the chat, so its streams rest. */
    val chatActive: Boolean,
    val onSignOut: () -> Unit,
    val onDisconnect: () -> Unit,
    val onKnowledgeDirtyChanged: (Boolean) -> Unit,
)

/**
 * Type-safe `@Serializable` destination registry. Every top-level screen, viewer, Knowledge page, remote browser,
 * and Settings sub-screen lives in [NavHost] so each gets its own `ViewModelStoreOwner`, `SavedStateHandle`, and
 * native Predictive Back animations.
 */
@Composable
fun ReiNavHost(nav: NavHostController, env: ShellEnv, modifier: Modifier = Modifier) {
    val scale = env.motionScale
    NavHost(
        navController = nav,
        startDestination = ChatRoute,
        modifier = modifier,
        enterTransition = { ReiMotion.enter(ReiEnter.Fade, scale) },
        exitTransition = { ReiMotion.exit(scale) },
        popEnterTransition = { ReiMotion.enter(ReiEnter.Fade, scale) },
        popExitTransition = { ReiMotion.exit(scale) },
    ) {
        composable<ChatRoute> {
            ChatScreen(
                api = env.api,
                sessionId = env.state.sessionId,
                historyLoaded = env.state.historyLoaded,
                chat = env.chat,
                active = env.chatActive,
                onOpenBrowser = {
                    env.state.sessionId?.let { id -> nav.navigate(BrowserRoute(id)) { launchSingleTop = true } }
                },
            )
        }
        composable<LibraryRoute> {
            val opener = LocalWorkspaceOpener.current
            LibraryScreen(env.container, env.api) { opener?.openFile(it.id) }
        }
        composable<KnowledgeRoute> {
            val opener = LocalWorkspaceOpener.current
            KnowledgeScreen(env.container, onOpenPage = { opener?.openPage(it) }, onNewPage = { opener?.newPage() })
        }
        composable<KnowledgePageRoute> { entry ->
            val route = entry.toRoute<KnowledgePageRoute>()
            val opener = LocalWorkspaceOpener.current
            KnowledgePageScreen(
                container = env.container,
                api = env.api,
                target = route.target,
                onOpenPage = { nextId -> opener?.openPage(nextId) },
                onClose = { nav.popBackStack() },
                onDirtyChanged = env.onKnowledgeDirtyChanged,
            )
        }
        composable<FileViewerRoute> { entry ->
            val route = entry.toRoute<FileViewerRoute>()
            FileViewerScreen(
                container = env.container,
                api = env.api,
                fileId = route.fileId,
                versionId = route.versionId,
                onClose = { nav.popBackStack() },
            )
        }
        composable<BrowserRoute> { entry ->
            val route = entry.toRoute<BrowserRoute>()
            BrowserScreen(env.container, route.sessionId) { nav.popBackStack() }
        }
        composable<ActivityRoute> {
            val shell = LocalShell.current
            ActivityScreen(
                store = env.shell.activity,
                onDecide = env.shell.activity::decideApproval,
                onOpenChat = { env.shell.openChat(it); shell.showChat() },
            )
        }
        composable<SearchRoute> {
            val shell = LocalShell.current
            HistorySearchScreen(env.shell, onOpened = shell::showChat)
        }

        // ---- Settings & nested sub-screens --------------------------------------------------------------------------

        composable<SettingsRoute> {
            val theme by env.shell.themePreference.collectAsStateWithLifecycle()
            SettingsIndex(
                api = env.api,
                serverUrl = env.state.serverUrl,
                themePreference = theme,
                onOpen = { page -> nav.navigate(SettingsDetailRoute(page)) { launchSingleTop = true } },
                onSignOut = env.onSignOut,
                onDisconnect = env.onDisconnect,
            )
        }
        composable<SettingsDetailRoute> { entry ->
            val page = entry.toRoute<SettingsDetailRoute>().page
            val shell = LocalShell.current
            val theme by env.shell.themePreference.collectAsStateWithLifecycle()
            val pop: () -> Unit = { nav.popBackStack() }
            when (page) {
                SettingsPage.Appearance -> AppearanceScreen(theme, env.shell::setThemePreference, pop)
                SettingsPage.Notifications -> NotificationsScreen(env.api, pop)
                SettingsPage.Devices -> DevicesScreen(env.api, env.onSignOut, pop)
                SettingsPage.Passkeys -> PasskeysScreen(env.api, pop)
                SettingsPage.Memory -> MemoryScreen(
                    api = env.api,
                    onOpenActivity = { shell.navigateTo(Destination.Activity) },
                    onOpenHistory = { id -> nav.navigate(SettingsMemoryHistoryRoute(id)) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Triggers -> TriggersScreen(
                    api = env.api,
                    onOpenTrigger = { id -> nav.navigate(SettingsTriggerDetailRoute(id)) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Usage -> UsageScreen(env.api, pop)
                SettingsPage.Permissions -> PermissionsScreen(
                    api = env.api,
                    onOpenSandbox = { nav.navigate(SettingsSandboxNetworkRoute) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.General -> GeneralScreen(
                    api = env.api,
                    onOpenTwoFactor = { nav.navigate(SettingsTwoFactorRoute) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Models -> ModelsScreen(env.api, pop)
                SettingsPage.Runtime -> RuntimeScreen(env.api, pop)
                SettingsPage.Providers -> ProvidersScreen(
                    onOpenSection = { section -> nav.navigate(SettingsProviderSectionRoute(section)) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Connectors -> ConnectorsScreen(
                    api = env.api,
                    onOpenConnector = { id -> nav.navigate(SettingsConnectorDetailRoute(id)) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Skills -> SkillsScreen(
                    api = env.api,
                    onOpenSkill = { id -> nav.navigate(SettingsSkillDetailRoute(id)) { launchSingleTop = true } },
                    onBack = pop,
                )
                SettingsPage.Plugins -> PluginsScreen(
                    api = env.api,
                    onOpenPlugin = { id -> nav.navigate(SettingsPluginDetailRoute(id)) { launchSingleTop = true } },
                    onBack = pop,
                )
            }
        }
        composable<SettingsTwoFactorRoute> {
            TwoFactorScreen(env.api) { nav.popBackStack() }
        }
        composable<SettingsSandboxNetworkRoute> {
            SandboxNetworkScreen(env.api) { nav.popBackStack() }
        }
        composable<SettingsProviderSectionRoute> { entry ->
            val section = entry.toRoute<SettingsProviderSectionRoute>().section
            val pop: () -> Unit = { nav.popBackStack() }
            when (section) {
                ProviderSection.Chat -> ChatProvidersScreen(
                    api = env.api,
                    onOpenForm = { kind, editingId -> nav.navigate(SettingsProviderFormRoute(kind, editingId)) },
                    onBack = pop,
                )
                ProviderSection.Embeddings -> EmbeddingScreen(env.api, pop)
                ProviderSection.Search -> SearchProvidersScreen(env.api, pop)
            }
        }
        composable<SettingsProviderFormRoute> { entry ->
            val route = entry.toRoute<SettingsProviderFormRoute>()
            ProviderEditorScreen(env.api, route.kind, route.editingId) { nav.popBackStack() }
        }
        composable<SettingsPluginDetailRoute> { entry ->
            val id = entry.toRoute<SettingsPluginDetailRoute>().pluginId
            PluginDetailScreen(
                api = env.api,
                id = id,
                onBack = { nav.popBackStack() },
                onEdit = { targetId ->
                    if (id == "new" && targetId != "new") {
                        nav.navigate(SettingsPluginDetailRoute(targetId)) {
                            popUpTo(SettingsPluginDetailRoute(id)) { inclusive = true }
                        }
                    } else {
                        nav.navigate(SettingsPluginEditRoute(targetId)) { launchSingleTop = true }
                    }
                },
                onOpenConnector = { connectorId ->
                    nav.navigate(SettingsConnectorDetailRoute(connectorId, fromPlugin = true)) { launchSingleTop = true }
                },
            )
        }
        composable<SettingsPluginEditRoute> { entry ->
            val id = entry.toRoute<SettingsPluginEditRoute>().pluginId
            PluginEditScreen(
                api = env.api,
                id = id,
                onBack = { nav.popBackStack() },
                onSaved = { nav.popBackStack() },
            )
        }
        composable<SettingsConnectorDetailRoute> { entry ->
            val route = entry.toRoute<SettingsConnectorDetailRoute>()
            ConnectorDetail(
                api = env.api,
                id = route.connectorId,
                canRemove = !route.fromPlugin,
                onBack = { nav.popBackStack() },
            )
        }
        composable<SettingsMemoryHistoryRoute> { entry ->
            val lineId = entry.toRoute<SettingsMemoryHistoryRoute>().lineId
            MemoryHistory(env.api, lineId) { nav.popBackStack() }
        }
        composable<SettingsSkillDetailRoute> { entry ->
            val id = entry.toRoute<SettingsSkillDetailRoute>().skillId
            SkillDetailScreen(
                api = env.api,
                id = id,
                onBack = { nav.popBackStack() },
                onOpenPlugin = { pluginId ->
                    nav.navigate(SettingsPluginDetailRoute(pluginId)) { launchSingleTop = true }
                },
            )
        }
        composable<SettingsTriggerDetailRoute> { entry ->
            val id = entry.toRoute<SettingsTriggerDetailRoute>().triggerId
            TriggerDetail(env.api, id) { nav.popBackStack() }
        }
    }
}
