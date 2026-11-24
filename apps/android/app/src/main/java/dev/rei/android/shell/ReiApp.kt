package dev.rei.android.shell

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DismissibleDrawerSheet
import androidx.compose.material3.DismissibleNavigationDrawer
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.PermanentDrawerSheet
import androidx.compose.material3.PermanentNavigationDrawer
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.window.core.layout.WindowSizeClass
import dev.rei.android.NotificationTarget
import dev.rei.android.ReiUiState
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.feature.agents.NewAgentSheet
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.knowledge.NewPageTarget
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.LocalSnackbarClearance
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.components.Notices
import dev.rei.android.ui.components.WorkspaceOpener
import dev.rei.android.ui.theme.LocalMotionScale
import kotlinx.coroutines.launch

private val DrawerWidth = 272.dp

/** Medium windows centre their content at the web column width. */
private val MediumColumn = 760.dp

/**
 * The signed-in app: an adaptive navigation drawer around the [NavHost] destination graph. Under 600dp the drawer
 * is modal, from 600 to 840dp dismissible, from 840dp permanent at 272dp. M3 `ModalDrawerSheet` / `DismissibleDrawerSheet`
 * and `NavHost` handle Predictive Back natively without manual `BackHandler` overrides.
 */
@Composable
internal fun ReiApp(
    state: ReiUiState,
    api: ReiApi,
    container: AppContainer,
    chat: ChatViewModel,
    shell: ShellViewModel,
    notificationTarget: NotificationTarget?,
    onOpenNotification: (NotificationTarget) -> Unit,
    onSignOut: () -> Unit,
    onDisconnect: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val current = Destination.fromNavDestination(entry?.destination)
    val width = currentWindowAdaptiveInfo().windowSizeClass
    val mode = when {
        width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND) -> DrawerMode.Permanent
        width.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND) -> DrawerMode.Dismissible
        else -> DrawerMode.Modal
    }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val drawer by shell.drawer.collectAsStateWithLifecycle()
    var chatSheet by remember { mutableStateOf<dev.rei.android.data.Session?>(null) }
    var newAgent by rememberSaveable { mutableStateOf(false) }
    var knowledgeDirty by remember { mutableStateOf(false) }
    var pendingNavigation by remember { mutableStateOf<(() -> Unit)?>(null) }

    val snackbar = remember { SnackbarHostState() }
    val notices = remember(snackbar, container) { Notices(snackbar, container.appScope) }
    var snackbarBottomClearance by remember { mutableStateOf(0.dp) }
    LaunchedEffect(entry?.destination?.id) { snackbarBottomClearance = 0.dp }
    val opener = remember(nav) {
        object : WorkspaceOpener {
            override fun openFile(fileId: String, versionId: String?) {
                nav.navigate(FileViewerRoute(fileId, versionId)) { launchSingleTop = true }
            }

            override fun openPage(pageId: String) {
                nav.navigate(KnowledgePageRoute(pageId)) { launchSingleTop = true }
            }

            override fun newPage() {
                nav.navigate(KnowledgePageRoute(NewPageTarget)) { launchSingleTop = true }
            }
        }
    }

    LaunchedEffect(container, snackbar) {
        container.workspaceRepository.notices.collect { notice ->
            snackbar.currentSnackbarData?.dismiss()
            val result = snackbar.showSnackbar(
                message = notice.message,
                actionLabel = notice.actionLabel,
                withDismissAction = notice.actionLabel == null,
                duration = if (notice.actionLabel != null) SnackbarDuration.Long else SnackbarDuration.Short,
            )
            if (result == SnackbarResult.ActionPerformed && notice.undo != null) {
                container.workspaceRepository.performUndo(notice.undo)
            }
        }
    }

    fun closeDrawer() {
        if (mode != DrawerMode.Permanent) scope.launch { drawerState.close() }
    }

    fun navigateTopLevel(destination: Destination) {
        nav.navigate(destination.toRoute()) {
            popUpTo<ChatRoute> { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    /** Guards tablet/drawer navigation away from a dirty Knowledge page with an explicit discard prompt. */
    fun guardNavigation(action: () -> Unit) {
        val onDirtyKnowledge = knowledgeDirty && entry?.destination?.hasRoute<KnowledgePageRoute>() == true
        if (onDirtyKnowledge) {
            pendingNavigation = action
        } else {
            action()
        }
    }

    val controller = rememberShellController(
        current = current,
        drawerMode = mode,
        onOpenDrawer = { scope.launch { drawerState.open() } },
        onNavigate = { destination ->
            guardNavigation {
                navigateTopLevel(destination)
                closeDrawer()
            }
        },
        onBack = { nav.popBackStack() },
        onOpenSettings = { page ->
            guardNavigation {
                navigateTopLevel(Destination.Settings)
                nav.navigate(SettingsDetailRoute(page)) { launchSingleTop = true }
                closeDrawer()
            }
        },
        onNewChat = { shell.newChat() },
        attentionCount = drawer.attentionCount,
    )

    LaunchedEffect(notificationTarget) {
        val target = notificationTarget ?: return@LaunchedEffect
        navigateTopLevel(Destination.Chat)
        onOpenNotification(target)
    }

    val actions = remember(shell, controller, mode) {
        DrawerActions(
            onSearch = { controller.navigateTo(Destination.Search) },
            onNewChat = { guardNavigation { shell.newChat(); controller.showChat() } },
            onNavigate = controller::navigateTo,
            onSelectAgent = { guardNavigation { shell.selectAgent(it); controller.showChat() } },
            onNewAgent = { closeDrawer(); newAgent = true },
            onOpenChat = { guardNavigation { shell.openChat(it); controller.showChat() } },
            onChatActions = { chatSheet = it },
            onShowTriggers = shell::setShowTriggers,
            onLoadMore = shell::loadMoreChats,
        )
    }

    val chatActive = entry?.destination?.hasRoute<ChatRoute>() == true
    val env = ShellEnv(
        state = state,
        api = api,
        container = container,
        chat = chat,
        shell = shell,
        motionScale = LocalMotionScale.current,
        chatActive = chatActive,
        onSignOut = onSignOut,
        onDisconnect = onDisconnect,
        onKnowledgeDirtyChanged = { knowledgeDirty = it },
    )
    val sheet: @Composable () -> Unit = { ReiDrawerContent(drawer, current, actions) }

    // Preserves NavHost state and back stack when resizing across 600dp/840dp drawer breakpoints.
    val body = remember {
        movableContentOf<ShellEnv, DrawerMode> { currentEnv, currentMode ->
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
                val drawerRoom by animateDpAsState(
                    if (currentMode == DrawerMode.Dismissible && drawerState.targetValue == DrawerValue.Open) DrawerWidth else 0.dp,
                    label = "drawer room",
                )
                val snackbarBottom by animateDpAsState(snackbarBottomClearance + 12.dp, label = "snackbar bottom")
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background)
                        .windowInsetsPadding(
                            WindowInsets.ime
                                .union(WindowInsets.navigationBars)
                                .union(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)),
                        )
                        .padding(end = drawerRoom),
                    contentAlignment = Alignment.TopCenter,
                ) {
                    Box(if (currentMode == DrawerMode.Dismissible) Modifier.widthIn(max = MediumColumn).fillMaxSize() else Modifier.fillMaxSize()) {
                        ReiNavHost(nav, currentEnv, Modifier.fillMaxSize())
                        SnackbarHost(
                            snackbar,
                            Modifier.align(Alignment.BottomCenter).padding(start = 12.dp, end = 12.dp, bottom = snackbarBottom),
                        )
                    }
                }
            }
        }
    }

    val onTopLevelScreen = entry?.destination?.let {
        it.hasRoute<ChatRoute>() ||
            it.hasRoute<LibraryRoute>() ||
            it.hasRoute<KnowledgeRoute>() ||
            it.hasRoute<ActivityRoute>() ||
            it.hasRoute<SettingsRoute>()
    } ?: true

    CompositionLocalProvider(
        LocalShell provides controller,
        LocalWorkspaceOpener provides opener,
        LocalNotices provides notices,
        LocalSnackbarClearance provides { snackbarBottomClearance = it },
    ) {
        when (mode) {
            DrawerMode.Modal -> ModalNavigationDrawer(
                drawerContent = {
                    ModalDrawerSheet(
                        modifier = Modifier.width(DrawerWidth),
                        drawerState = drawerState,
                        drawerContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    ) { sheet() }
                },
                drawerState = drawerState,
                gesturesEnabled = onTopLevelScreen,
                content = { body(env, mode) },
            )
            DrawerMode.Dismissible -> DismissibleNavigationDrawer(
                drawerContent = {
                    DismissibleDrawerSheet(
                        modifier = Modifier.width(DrawerWidth),
                        drawerState = drawerState,
                        drawerContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    ) { sheet() }
                },
                drawerState = drawerState,
                gesturesEnabled = onTopLevelScreen,
                content = { body(env, mode) },
            )
            DrawerMode.Permanent -> PermanentNavigationDrawer(
                drawerContent = {
                    PermanentDrawerSheet(
                        modifier = Modifier.width(DrawerWidth),
                        drawerContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    ) { sheet() }
                },
                content = { body(env, mode) },
            )
        }
        if (newAgent) {
            NewAgentSheet(
                container = container,
                onDismiss = { newAgent = false },
                onCreated = { agent -> newAgent = false; shell.selectAgent(agent); controller.showChat() },
            )
        }
        chatSheet?.let { session ->
            ChatActionsSheet(
                session = session,
                handler = object : ChatActionHandler {
                    override fun rename(id: String, title: String) = shell.renameChat(id, title)
                    override fun pin(id: String, pinned: Boolean) = shell.pinChat(id, pinned)
                    override fun delete(id: String) = shell.deleteChat(id)
                },
                onDismiss = { chatSheet = null },
            )
        }
        pendingNavigation?.let { proceed ->
            ConfirmDialog(
                title = "Discard changes?",
                text = "What you typed on this page won’t be saved.",
                confirmLabel = "Discard",
                destructive = true,
                onConfirm = {
                    knowledgeDirty = false
                    pendingNavigation = null
                    proceed()
                },
                onDismiss = { pendingNavigation = null },
            )
        }
    }
}
