package dev.rei.android.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.DismissibleDrawerSheet
import androidx.compose.material3.DismissibleNavigationDrawer
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.PermanentDrawerSheet
import androidx.compose.material3.PermanentNavigationDrawer
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.rei.android.BrowserScreen
import dev.rei.android.NotificationTarget
import dev.rei.android.ReiUiState
import dev.rei.android.ReiViewModel
import dev.rei.android.data.Session
import dev.rei.android.feature.chat.ChatViewModel
import dev.rei.android.feature.knowledge.KnowledgePageScreen
import dev.rei.android.feature.knowledge.NewPageTarget
import dev.rei.android.feature.viewer.FileViewerScreen
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.components.Notices
import dev.rei.android.ui.components.WorkspaceOpener
import dev.rei.android.feature.agents.NewAgentSheet
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.ui.theme.LocalMotionScale
import kotlinx.coroutines.launch

private val DrawerWidth = 272.dp

/** Medium windows centre their content at the web column width. */
private val MediumColumn = 760.dp

/**
 * The signed-in app: an adaptive navigation drawer around the destination graph. Under 600dp the drawer is modal, from
 * 600 to 840dp dismissible, from 840dp permanent at 272dp. Back closes the drawer first, then leaves a sub-screen, then
 * returns to the chat; the keyboard and sheets close before any of these by themselves.
 */
@Composable
internal fun ReiApp(
    state: ReiUiState,
    model: ReiViewModel,
    chat: ChatViewModel,
    shell: ShellViewModel,
    notificationTarget: NotificationTarget?,
    consumeNotification: () -> Unit,
) {
    val api = state.api ?: return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val current = Destination.fromRoute(entry?.destination?.route)
    val width = currentWindowAdaptiveInfo().windowSizeClass
    val mode = when {
        width.isWidthAtLeastBreakpoint(840) -> DrawerMode.Permanent
        width.isWidthAtLeastBreakpoint(600) -> DrawerMode.Dismissible
        else -> DrawerMode.Modal
    }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val drawer by shell.drawer.collectAsStateWithLifecycle()
    var browserSession by rememberSaveable { mutableStateOf<String?>(null) }
    var chatSheet by remember { mutableStateOf<Session?>(null) }
    var newAgent by rememberSaveable { mutableStateOf(false) }
    // The file viewer and the page view are full-screen overlays the shell hosts, so a chat chip, a Library card or a link in
    // a page can open them without a destination of their own, and the Undo snackbar outlives the screen that raised it.
    var viewerFile by rememberSaveable { mutableStateOf<String?>(null) }
    var viewerVersion by rememberSaveable { mutableStateOf<String?>(null) }
    var pageTarget by rememberSaveable { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val notices = remember(scope) { Notices(snackbar, scope) }
    val opener = remember {
        object : WorkspaceOpener {
            override fun openFile(fileId: String, versionId: String?) { viewerFile = fileId; viewerVersion = versionId }
            override fun openPage(pageId: String) { pageTarget = pageId }
            override fun newPage() { pageTarget = NewPageTarget }
        }
    }
    var settingsTarget by rememberSaveable { mutableStateOf<String?>(null) }
    val overlayOpen = viewerFile != null || pageTarget != null

    val inChat = current == Destination.Chat && state.sessionId != null
    val browserId = browserSession?.takeIf { inChat && it == state.sessionId }

    fun closeDrawer() {
        if (mode != DrawerMode.Permanent) scope.launch { drawerState.close() }
    }

    fun navigate(destination: Destination) {
        nav.navigate(destination.route) {
            popUpTo(Destination.Chat.route) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    val controller = rememberShellController(
        current = current,
        drawerMode = mode,
        onOpenDrawer = { scope.launch { drawerState.open() } },
        onNavigate = { destination ->
            browserSession = null
            viewerFile = null
            pageTarget = null
            navigate(destination)
            closeDrawer()
        },
        onBack = { nav.popBackStack() },
        onOpenSettings = { page ->
            browserSession = null
            viewerFile = null
            pageTarget = null
            settingsTarget = page.name
            navigate(Destination.Settings)
        },
    )

    LaunchedEffect(notificationTarget) {
        val target = notificationTarget ?: return@LaunchedEffect
        browserSession = null
        viewerFile = null
        pageTarget = null
        navigate(Destination.Chat)
        model.openNotification(target)
        consumeNotification()
    }

    val actions = remember(shell, controller, mode) {
        DrawerActions(
            onSearch = { controller.navigateTo(Destination.Search) },
            onNewChat = { shell.newChat(); controller.showChat() },
            onNavigate = controller::navigateTo,
            onSelectAgent = { shell.selectAgent(it); controller.showChat() },
            onNewAgent = { closeDrawer(); newAgent = true },
            onOpenChat = { shell.openChat(it); controller.showChat() },
            onChatActions = { chatSheet = it },
            onShowTriggers = shell::setShowTriggers,
            onLoadMore = shell::loadMoreChats,
        )
    }
    val env = ShellEnv(state, api, model, chat, shell, LocalMotionScale.current, chatActive = browserId == null, onOpenBrowser = { browserSession = it },
        settingsTarget = settingsTarget?.let { name -> SettingsPage.entries.firstOrNull { it.name == name } }, onSettingsTargetShown = { settingsTarget = null })
    val sheet: @Composable () -> Unit = { ReiDrawerContent(drawer, current, actions) }

    val body: @Composable () -> Unit = {
        // The shell paints the canvas, so text with no explicit color reads on it in both themes.
        CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
            // A dismissible drawer slides the page aside instead of narrowing it, so the page gives up the drawer's width
            // on the other side while it is open; otherwise its right edge would sit off screen.
            val drawerRoom by animateDpAsState(
                if (mode == DrawerMode.Dismissible && drawerState.targetValue == DrawerValue.Open) DrawerWidth else 0.dp,
                label = "drawer room",
            )
            Box(
                Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.background)
                    .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
                    .padding(end = drawerRoom),
                contentAlignment = Alignment.TopCenter,
            ) {
                Box(if (mode == DrawerMode.Dismissible) Modifier.widthIn(max = MediumColumn).fillMaxSize() else Modifier.fillMaxSize()) {
                    ReiNavHost(nav, env, Modifier.fillMaxSize())
                    if (browserId != null) {
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).statusBarsPadding()) {
                            BrowserScreen(api, browserId) { browserSession = null }
                        }
                    }
                    pageTarget?.let { target ->
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                            KnowledgePageScreen(model, api, target, onOpenPage = { pageTarget = it }, onClose = { pageTarget = null })
                        }
                    }
                    viewerFile?.let { id ->
                        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                            FileViewerScreen(model, api, id, viewerVersion) { viewerFile = null; viewerVersion = null }
                        }
                    }
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp, vertical = 12.dp))
                }
            }
        }
        // Registered after the graph, so it answers before the graph does: drawer first, then the browser.
        BackHandler(mode != DrawerMode.Permanent && drawerState.currentValue == DrawerValue.Open) { closeDrawer() }
        BackHandler(browserId != null) { browserSession = null }
    }

    CompositionLocalProvider(LocalShell provides controller, LocalWorkspaceOpener provides opener, LocalNotices provides notices) {
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
                gesturesEnabled = browserId == null && !overlayOpen,
                content = body,
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
                gesturesEnabled = browserId == null && !overlayOpen,
                content = body,
            )
            DrawerMode.Permanent -> PermanentNavigationDrawer(
                drawerContent = {
                    PermanentDrawerSheet(
                        modifier = Modifier.width(DrawerWidth),
                        drawerContainerColor = MaterialTheme.colorScheme.surfaceContainer,
                    ) { sheet() }
                },
                content = body,
            )
        }
        if (newAgent) {
            NewAgentSheet(
                api = api,
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
    }
}
