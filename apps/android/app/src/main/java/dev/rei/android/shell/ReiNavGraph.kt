package dev.rei.android.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.layout.PaneAdaptedValue
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import androidx.window.core.layout.WindowSizeClass
import dev.rei.android.BrowserScreen
import dev.rei.android.ReiUiState
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.feature.activity.ActivityScreen
import dev.rei.android.feature.chat.ChatScreen
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.knowledge.KnowledgePageScreen
import dev.rei.android.feature.knowledge.KnowledgeScreen
import dev.rei.android.feature.knowledge.NewPageTarget
import dev.rei.android.feature.library.LibraryScreen
import dev.rei.android.feature.settings.AppearanceScreen
import dev.rei.android.feature.settings.ChatProvidersScreen
import dev.rei.android.feature.settings.ConnectorDetail
import dev.rei.android.feature.settings.ConnectorsScreen
import dev.rei.android.feature.settings.DevicesScreen
import dev.rei.android.feature.settings.EmbeddingScreen
import dev.rei.android.feature.settings.GeneralScreen
import dev.rei.android.feature.settings.LocalSubScreenHideBack
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
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiMotion
import kotlinx.coroutines.launch

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
@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun ReiNavHost(nav: NavHostController, env: ShellEnv, modifier: Modifier = Modifier) {
    val scale = env.motionScale
    val density = LocalDensity.current.density
    val expanded = currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)
    NavHost(
        navController = nav,
        startDestination = ChatRoute,
        modifier = modifier,
        enterTransition = { ReiMotion.enter(ReiEnter.Fade, scale, density) },
        exitTransition = { ReiMotion.exit(scale) },
        popEnterTransition = { ReiMotion.enter(ReiEnter.Fade, scale, density) },
        popExitTransition = { ReiMotion.exit(scale) },
        predictivePopEnterTransition = { _ -> ReiMotion.predictivePopEnter(scale) },
        predictivePopExitTransition = { swipeEdge -> ReiMotion.predictivePopExit(swipeEdge, scale) },
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
            LibraryScreen(env.container, env.api, onOpen = { opener?.openFile(it.id) })
        }
        composable<KnowledgeRoute> {
            val opener = LocalWorkspaceOpener.current
            if (expanded) {
                val navigator = rememberListDetailPaneScaffoldNavigator<String>()
                val scope = rememberCoroutineScope()
                var newPageSeq by rememberSaveable { mutableIntStateOf(0) }
                BackHandler(enabled = navigator.canNavigateBack()) { scope.launch { navigator.navigateBack() } }
                val bothExpanded = navigator.scaffoldValue[ListDetailPaneScaffoldRole.List] == PaneAdaptedValue.Expanded
                ListDetailPaneScaffold(
                    directive = navigator.scaffoldDirective,
                    value = navigator.scaffoldValue,
                    listPane = {
                        AnimatedPane {
                            KnowledgeScreen(
                                env.container,
                                onOpenPage = { id -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, id) } },
                                onNewPage = {
                                    newPageSeq++
                                    scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, "$NewPageTarget:$newPageSeq") }
                                },
                            )
                        }
                    },
                    detailPane = {
                        AnimatedPane {
                            val contentKey = navigator.currentDestination?.contentKey
                            if (contentKey != null) {
                                val target = if (contentKey.startsWith("$NewPageTarget:")) NewPageTarget else contentKey
                                key(contentKey) {
                                    KnowledgePageScreen(
                                        container = env.container,
                                        api = env.api,
                                        target = target,
                                        onOpenPage = { nextId -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, nextId) } },
                                        onClose = { scope.launch { navigator.navigateBack() } },
                                        onDirtyChanged = env.onKnowledgeDirtyChanged,
                                        showBack = !bothExpanded,
                                        viewModelKey = contentKey,
                                    )
                                }
                            } else {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    EmptyState(
                                        ReiIcons.Knowledge,
                                        "Select a page",
                                        body = "Choose a Knowledge page from the list or create a new one.",
                                    )
                                }
                            }
                        }
                    },
                )
            } else {
                KnowledgeScreen(env.container, onOpenPage = { opener?.openPage(it) }, onNewPage = { opener?.newPage() })
            }
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
            BrowserScreen(env.container, route.sessionId, onBack = { nav.popBackStack() })
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
            if (expanded) {
                val navigator = rememberListDetailPaneScaffoldNavigator<SettingsPage>()
                val scope = rememberCoroutineScope()
                BackHandler(enabled = navigator.canNavigateBack()) { scope.launch { navigator.navigateBack() } }
                val bothExpanded = navigator.scaffoldValue[ListDetailPaneScaffoldRole.List] == PaneAdaptedValue.Expanded
                ListDetailPaneScaffold(
                    directive = navigator.scaffoldDirective,
                    value = navigator.scaffoldValue,
                    listPane = {
                        AnimatedPane {
                            SettingsIndex(
                                api = env.api,
                                serverUrl = env.state.serverUrl,
                                themePreference = theme,
                                onOpen = { page -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, page) } },
                                onSignOut = env.onSignOut,
                                onDisconnect = env.onDisconnect,
                            )
                        }
                    },
                    detailPane = {
                        AnimatedPane {
                            val page = navigator.currentDestination?.contentKey ?: SettingsPage.General
                            CompositionLocalProvider(LocalSubScreenHideBack provides bothExpanded) {
                                key(page) {
                                    SettingsDetailContent(
                                        page = page,
                                        env = env,
                                        nav = nav,
                                        onBack = { scope.launch { navigator.navigateBack() } },
                                        onOpenPage = { target -> scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, target) } },
                                    )
                                }
                            }
                        }
                    },
                )
            } else {
                SettingsIndex(
                    api = env.api,
                    serverUrl = env.state.serverUrl,
                    themePreference = theme,
                    onOpen = { page -> nav.navigate(SettingsDetailRoute(page)) { launchSingleTop = true } },
                    onSignOut = env.onSignOut,
                    onDisconnect = env.onDisconnect,
                )
            }
        }
        composable<SettingsDetailRoute> { entry ->
            val page = entry.toRoute<SettingsDetailRoute>().page
            SettingsDetailContent(
                page = page,
                env = env,
                nav = nav,
                onBack = { nav.popBackStack() },
                onOpenPage = { target -> nav.navigate(SettingsDetailRoute(target)) { launchSingleTop = true } },
            )
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

@Composable
private fun SettingsDetailContent(
    page: SettingsPage,
    env: ShellEnv,
    nav: NavHostController,
    onBack: () -> Unit,
    onOpenPage: (SettingsPage) -> Unit,
) {
    val shell = LocalShell.current
    val theme by env.shell.themePreference.collectAsStateWithLifecycle()
    when (page) {
        SettingsPage.Appearance -> AppearanceScreen(theme, env.shell::setThemePreference, onBack)
        SettingsPage.Notifications -> NotificationsScreen(env.api, onBack)
        SettingsPage.Devices -> DevicesScreen(env.api, env.onSignOut, onBack)
        SettingsPage.Passkeys -> PasskeysScreen(env.api, onBack)
        SettingsPage.TwoFactor -> TwoFactorScreen(env.api, onBack)
        SettingsPage.Memory -> MemoryScreen(
            api = env.api,
            onOpenActivity = { shell.navigateTo(Destination.Activity) },
            onOpenHistory = { id -> nav.navigate(SettingsMemoryHistoryRoute(id)) { launchSingleTop = true } },
            onBack = onBack,
            onOpenReviewSettings = { onOpenPage(SettingsPage.General) },
        )
        SettingsPage.Triggers -> TriggersScreen(
            api = env.api,
            onOpenTrigger = { id -> nav.navigate(SettingsTriggerDetailRoute(id)) { launchSingleTop = true } },
            onBack = onBack,
        )
        SettingsPage.Usage -> UsageScreen(env.api, onBack)
        SettingsPage.Permissions -> PermissionsScreen(
            api = env.api,
            onOpenSandbox = { nav.navigate(SettingsSandboxNetworkRoute) { launchSingleTop = true } },
            onBack = onBack,
        )
        SettingsPage.General -> GeneralScreen(api = env.api, onBack = onBack)
        SettingsPage.Models -> ModelsScreen(env.api, onBack)
        SettingsPage.Runtime -> RuntimeScreen(env.api, onBack)
        SettingsPage.Providers -> ProvidersScreen(
            onOpenSection = { section -> nav.navigate(SettingsProviderSectionRoute(section)) { launchSingleTop = true } },
            onBack = onBack,
        )
        SettingsPage.Connectors -> ConnectorsScreen(
            api = env.api,
            onOpenConnector = { id -> nav.navigate(SettingsConnectorDetailRoute(id)) { launchSingleTop = true } },
            onBack = onBack,
        )
        SettingsPage.Skills -> SkillsScreen(
            api = env.api,
            onOpenSkill = { id -> nav.navigate(SettingsSkillDetailRoute(id)) { launchSingleTop = true } },
            onBack = onBack,
        )
        SettingsPage.Plugins -> PluginsScreen(
            api = env.api,
            onOpenPlugin = { id -> nav.navigate(SettingsPluginDetailRoute(id)) { launchSingleTop = true } },
            onBack = onBack,
        )
    }
}
