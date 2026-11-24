package dev.rei.android.feature.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.SupportingPaneScaffold
import androidx.compose.material3.adaptive.layout.SupportingPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.rememberSupportingPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.window.core.layout.WindowSizeClass
import dev.rei.android.R
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.Message
import dev.rei.android.data.ReiApi
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.shell.LocalShell
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.AgentAvatar
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.LocalSnackbarClearance
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.ReiScreenPreviewSurface
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.components.copyToClipboard
import dev.rei.android.ui.components.ApprovalCard
import dev.rei.android.ui.components.chat.AssistantBubble
import dev.rei.android.ui.components.chat.AttachmentSheet
import dev.rei.android.ui.components.chat.Composer
import dev.rei.android.ui.components.chat.ComposerState
import dev.rei.android.ui.components.chat.EditMessageSheet
import dev.rei.android.ui.components.chat.EffortSheet
import dev.rei.android.ui.components.chat.ImageViewer
import dev.rei.android.ui.components.chat.LibraryAttachmentSheet
import dev.rei.android.ui.components.chat.MessageSheet
import dev.rei.android.ui.components.chat.MessageSheetActions
import dev.rei.android.ui.components.chat.ModelSheet
import dev.rei.android.ui.components.chat.PermissionsSheet
import dev.rei.android.ui.components.chat.NoticeLine
import dev.rei.android.ui.components.chat.PendingBubble
import dev.rei.android.ui.components.chat.ReplyActions
import dev.rei.android.ui.components.chat.SelectTextSheet
import dev.rei.android.ui.components.chat.SkillSheet
import dev.rei.android.ui.components.chat.TakeoverCard
import dev.rei.android.ui.components.chat.ThinkingLine
import dev.rei.android.ui.components.chat.ToolActivityRow
import dev.rei.android.ui.components.chat.UserBubble
import dev.rei.android.ui.components.chat.effortLabel
import dev.rei.android.ui.components.markdown.LocalPictureOpener
import dev.rei.android.ui.components.markdown.PictureSource
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.MotionRegion
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/** The transcript's reading column on wide screens; matches the web's. */
private val ReadingColumn = 760.dp

/**
 * The chat destination: the open chat under the shell's top bar, or a prompt to start one. All state comes from
 * [ChatViewModel]; [active] is false while something covers the chat (the live browser), so streams and read markers rest.
 */
@Composable
fun ChatScreen(
    api: ReiApi,
    sessionId: String?,
    historyLoaded: Boolean,
    chat: ChatViewModel,
    active: Boolean,
    onOpenBrowser: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (sessionId == null) {
        val shell = LocalShell.current
        ChatEmptyContent(historyLoaded = historyLoaded, onNewChat = shell::newChat, modifier = modifier)
        return
    }
    key(sessionId) { Conversation(api, sessionId, chat, active, onOpenBrowser, modifier.fillMaxSize()) }
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
private fun Conversation(
    api: ReiApi,
    sessionId: String,
    chat: ChatViewModel,
    active: Boolean,
    onOpenBrowser: () -> Unit,
    modifier: Modifier,
) {
    val state by chat.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val shell = LocalShell.current
    val opener = LocalWorkspaceOpener.current
    val listState = rememberLazyListState()
    val notices = LocalNotices.current
    val setClearance = LocalSnackbarClearance.current
    val density = LocalDensity.current
    val keyboard = LocalSoftwareKeyboardController.current
    val motionScale = LocalMotionScale.current
    val agentName = state.agent?.name ?: stringResource(R.string.app_name)
    val pickers = rememberAttachmentPickers(sessionId, chat)

    LaunchedEffect(active) { chat.setVisible(active) }
    DisposableEffect(Unit) { onDispose { chat.setVisible(false) } }

    val items = remember(state.messages, state.runs, state.detail?.generation, state.pending, state.busy) {
        buildTranscript(state.messages, state.runs, state.detail?.generation, state.pending, state.busy)
    }
    // The list is reversed (index 0 is the newest), so it opens at the bottom and older pages never move what you read.
    val display = remember(items) { items.asReversed() }
    val outcomes = remember(state.messages) { state.messages.mapNotNull { it.approval }.associate { it.id to it.status } }

    // ---- sheets and dialogs --------------------------------------------------------------------------------------
    var messageSheet by remember { mutableStateOf<String?>(null) }
    var selecting by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<Message?>(null) }
    var inspect by remember { mutableStateOf<InspectTarget?>(null) }
    var image by remember { mutableStateOf<PictureSource?>(null) }
    var attach by remember { mutableStateOf(false) }
    var library by remember { mutableStateOf(false) }
    var skills by remember { mutableStateOf(false) }
    var modelSheet by remember { mutableStateOf(false) }
    var effortSheet by remember { mutableStateOf(false) }
    var permissionsSheet by remember { mutableStateOf(false) }
    var confirmRetry by remember { mutableStateOf<Message?>(null) }
    var confirmFork by remember { mutableStateOf<Message?>(null) }

    // ---- scrolling -----------------------------------------------------------------------------------------------
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 && listState.firstVisibleItemScrollOffset <= 48 } }
    var pinned by remember { mutableStateOf(true) }
    var newBelow by remember { mutableStateOf(false) }
    val scrolled by remember { derivedStateOf { listState.canScrollForward } }
    val current by rememberUpdatedState(state)
    val currentDisplay by rememberUpdatedState(display)

    // "Pinned" is decided when you stop scrolling, so content arriving under you never flips it by itself.
    LaunchedEffect(listState) { snapshotFlow { listState.isScrollInProgress }.filter { !it }.collect { pinned = atBottom } }
    LaunchedEffect(atBottom) {
        chat.setAtBottom(atBottom)
        if (atBottom) newBelow = false
    }
    val latest = items.lastOrNull()
    val latestStepCount = (latest as? TranscriptItem.Activity)?.run?.steps?.size ?: 0
    val streamingChars = state.detail?.generation?.length ?: 0
    LaunchedEffect(latest?.key, latestStepCount, streamingChars) {
        val last = latest ?: return@LaunchedEffect
        val mine = last is TranscriptItem.Pending || last is TranscriptItem.User
        if (pinned || mine) {
            if (streamingChars > 0 || motionScale == 0f) listState.scrollToItem(0)
            else listState.animateScrollToItem(0)
            pinned = true
        } else {
            newBelow = true
        }
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.layoutInfo.let { it.visibleItemsInfo.lastOrNull()?.index to it.totalItemsCount } }.collect { (last, total) ->
            if (last != null && total > 0 && last >= total - 3) {
                if (current.olderAvailable) chat.loadOlder() else if (current.traceOlder != null) chat.loadOlderActivity()
            }
        }
    }
    LaunchedEffect(state.older.size) { if (state.older.isNotEmpty() && current.traceOlder != null) chat.loadOlderActivity() }
    LaunchedEffect(state.focus) {
        val target = state.focus ?: return@LaunchedEffect
        val index = currentDisplay.indexOfFirst { it.key == target }
        if (index >= 0) {
            listState.scrollToItem(index, -(listState.layoutInfo.viewportSize.height / 3))
            delay(1600)
        }
        chat.consumeFocus(target)
    }
    LaunchedEffect(state.notice) {
        val message = state.notice?.asString(context) ?: return@LaunchedEffect
        notices?.show(message)
        chat.consumeNotice()
    }
    val dismissKeyboardOnDrag = remember(keyboard) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) {
                    keyboard?.hide()
                }
                return Offset.Zero
            }
        }
    }
    DisposableEffect(Unit) { onDispose { setClearance(0.dp) } }

    val clipboardLabel = stringResource(R.string.chat_clipboard_label)
    fun copy(text: String) = copyToClipboard(context, clipboardLabel, text)

    val expanded = currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)
    val approvalMessages = remember(state.messages) { state.messages.mapNotNull { m -> m.approval?.let { a -> a.id to m.id } }.toMap() }

    val chatContent: @Composable (Modifier) -> Unit = { paneModifier ->
        Column(paneModifier) {
            ChatTopBar(
                state = state,
                scrolled = scrolled,
                chat = chat,
                onInspect = { inspect = InspectTarget() },
                onOpenBrowser = onOpenBrowser,
            )
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
                Box(Modifier.widthIn(max = ReadingColumn).fillMaxSize()) {
                    MotionRegion(key = sessionId, ready = state.ready) {
                        CompositionLocalProvider(LocalPictureOpener provides { image = it }) {
                            LazyColumn(
                                state = listState,
                                reverseLayout = true,
                                modifier = Modifier.fillMaxSize().nestedScroll(dismissKeyboardOnDrag),
                                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(display, key = { it.key }, contentType = { it::class }) { item ->
                                    TranscriptRow(
                                        item = item,
                                        state = state,
                                        api = api,
                                        sessionId = sessionId,
                                        agentName = agentName,
                                        outcomes = outcomes,
                                        chat = chat,
                                        onLongPress = { messageSheet = it.id },
                                        onInspectRun = { inspect = InspectTarget(runId = it) },
                                        onInspectStep = { run, step -> inspect = InspectTarget(runId = run, stepId = step) },
                                        onCopy = ::copy,
                                        onOpenBrowser = onOpenBrowser,
                                        onOpenPage = { opener?.openPage(it) },
                                    )
                                }
                                if (state.loadingOlder) item(key = "older") {
                                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                                    }
                                }
                            }
                        }
                    }
                    when {
                        !state.ready && state.streamError == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(28.dp))
                        }
                        state.ready && display.isEmpty() -> EmptyChat(state)
                    }
                    Column(Modifier.align(Alignment.TopCenter).padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (state.reconnecting) {
                            StatusBanner(
                                stringResource(R.string.chat_reconnecting),
                                actionLabel = stringResource(R.string.common_retry),
                                onAction = chat::retryStream,
                            )
                        } else if (state.streamError != null) {
                            StatusBanner(
                                state.streamError?.asString().orEmpty(),
                                kind = StatusKind.Error,
                                actionLabel = stringResource(R.string.common_retry),
                                onAction = chat::retryStream,
                            )
                        }
                    }
                    val scope = rememberCoroutineScope()
                    if (!atBottom) {
                        JumpToLatest(
                            newContent = newBelow,
                            onClick = {
                                pinned = true
                                newBelow = false
                                scope.launch { listState.animateScrollToItem(0) }
                            },
                            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                        )
                    }
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .onSizeChanged { setClearance(with(density) { it.height.toDp() }) },
                contentAlignment = Alignment.BottomCenter,
            ) {
                val catalog = state.models
                val agentModel = state.agent?.model
                Composer(
                    state = ComposerState(
                        draft = state.draft,
                        draftEpoch = state.draftEpoch,
                        attachments = state.attachments,
                        skills = state.skills,
                        uploading = state.uploading,
                        running = state.busy,
                        stopping = state.stopping,
                        sending = state.pending != null,
                        waitingForAnswer = state.waitingForAnswer,
                        agentName = agentName.takeIf { state.agent != null }.orEmpty(),
                        modelLabel = catalog?.label(agentModel) ?: agentModel?.substringAfterLast('/'),
                        effortLabel = state.agent?.let { effortLabel(it.thinkingLevel) },
                        profile = state.profile,
                        contextPercent = state.usage?.percent,
                        enabled = state.ready,
                    ),
                    onDraftChange = chat::editDraft,
                    onSend = chat::send,
                    onStop = chat::stop,
                    onAttach = { attach = true },
                    onRemoveAttachment = chat::removeAttachment,
                    onModel = { modelSheet = true },
                    onEffort = { effortSheet = true },
                    onPermissions = { chat.clearProfileError(); permissionsSheet = true },
                    modifier = Modifier.widthIn(max = ReadingColumn),
                    onRemoveSkill = chat::removeSkill,
                    selectedSkills = state.selectedSkills,
                    onSelectSkill = chat::selectSkill,
                    onLoadSkills = chat::loadSkills,
                    onJumpToApproval = {
                        val pendingId = state.messages.firstOrNull { it.approval?.status == "pending" }?.id
                        if (pendingId != null) chat.focusMessage(pendingId)
                    },
                )
            }
        }
    }

    if (expanded) {
        val navigator = rememberSupportingPaneScaffoldNavigator()
        LaunchedEffect(inspect) {
            if (inspect != null) navigator.navigateTo(SupportingPaneScaffoldRole.Supporting)
            else if (navigator.canNavigateBack()) navigator.navigateBack()
        }
        BackHandler(enabled = inspect != null) { inspect = null }
        SupportingPaneScaffold(
            directive = navigator.scaffoldDirective,
            value = navigator.scaffoldValue,
            modifier = modifier,
            mainPane = {
                AnimatedPane {
                    chatContent(Modifier.fillMaxSize())
                }
            },
            supportingPane = {
                AnimatedPane {
                    inspect?.let { target ->
                        InspectPane(
                            api = api,
                            runs = state.runs,
                            target = target,
                            onDismiss = { inspect = null },
                            approvalMessages = approvalMessages,
                            onOpenApproval = chat::focusMessage,
                        )
                    }
                }
            },
        )
    } else {
        chatContent(modifier)
    }

    LaunchedEffect(messageSheet, state.messages) {
        val id = messageSheet ?: return@LaunchedEffect
        if (state.messages.none { it.id == id }) messageSheet = null
    }
    LaunchedEffect(modelSheet, state.models) {
        if (modelSheet && state.models == null) modelSheet = false
    }

    // ---- sheets --------------------------------------------------------------------------------------------------
    messageSheet?.let { id ->
        val message = state.messages.firstOrNull { it.id == id }
        if (message != null) {
            val user = message.role == "user"
            val retryTarget = if (user) message else items.filterIsInstance<TranscriptItem.Reply>().firstOrNull { it.message.id == id }?.retryOf
            val canRewrite = retryTarget?.editable == true && !state.busy
            MessageSheet(
                message = message,
                actions = MessageSheetActions(
                    onCopy = { copy(message.text); messageSheet = null },
                    onSelectText = { selecting = message.text; messageSheet = null },
                    onEdit = if (user && canRewrite) ({ editing = message; messageSheet = null }) else null,
                    onRetry = if (canRewrite) ({ confirmRetry = retryTarget; messageSheet = null }) else null,
                    onFork = if (message.forkable) ({ confirmFork = message; messageSheet = null }) else null,
                    onSwitchVersion = if (user && (message.versions?.count ?: 0) > 1 && !state.busy) ({ next -> chat.switchVersion(message, next) }) else null,
                ),
                onDismiss = { messageSheet = null },
            )
        }
    }
    confirmRetry?.let { target ->
        ConfirmDialog(
            title = stringResource(R.string.chat_retry_title),
            text = stringResource(R.string.chat_retry_body),
            confirmLabel = stringResource(R.string.common_retry),
            onConfirm = { chat.retry(target); confirmRetry = null },
            onDismiss = { confirmRetry = null },
        )
    }
    confirmFork?.let { target ->
        ConfirmDialog(
            title = stringResource(R.string.chat_fork_title),
            text = stringResource(R.string.chat_fork_body),
            confirmLabel = stringResource(R.string.chat_fork_action),
            onConfirm = { chat.fork(target); confirmFork = null },
            onDismiss = { confirmFork = null },
        )
    }
    selecting?.let { SelectTextSheet(it) { selecting = null } }
    editing?.let { message ->
        EditMessageSheet(message.text, onDismiss = { editing = null }, onSend = { chat.edit(message, it); editing = null })
    }
    if (!expanded) {
        inspect?.let {
            InspectSheet(
                api,
                state.runs,
                it,
                onDismiss = { inspect = null },
                approvalMessages = approvalMessages,
                onOpenApproval = chat::focusMessage,
            )
        }
    }
    image?.let { ImageViewer(api, it) { image = null } }
    if (attach) {
        AttachmentSheet(
            onDismiss = { attach = false },
            onDeviceFiles = { attach = false; pickers.deviceFiles() },
            onPhotos = { attach = false; pickers.photos() },
            onLibrary = { attach = false; library = true },
            onSlashCommands = { attach = false; skills = true; chat.loadSkills() },
            attachmentsFull = state.attachments.size >= AttachmentRef.MaxCount,
        )
    }
    if (library) LibraryAttachmentSheet(api, onDismiss = { library = false }, onSelect = { chat.addAttachment(it); library = false })
    if (skills) SkillSheet(state.skills, loaded = state.skillsLoaded, onDismiss = { skills = false }, onSelect = { chat.selectSkill(it); skills = false })
    if (modelSheet) {
        val catalog = state.models
        if (catalog != null) {
            ModelSheet(catalog, state.agent?.model, onDismiss = { modelSheet = false }, onSelect = { chat.setModel(it); modelSheet = false })
        }
    }
    if (permissionsSheet) {
        PermissionsSheet(
            current = state.profile,
            saving = state.savingProfile,
            error = state.profileError?.asString(),
            onDismiss = { permissionsSheet = false; chat.clearProfileError() },
            onSelect = { level -> chat.setProfile(level) { permissionsSheet = false } },
            onOpenSettings = { permissionsSheet = false; shell.openSettings(SettingsPage.Permissions) },
        )
    }
    if (effortSheet) {
        val catalog = state.models
        val levels = catalog?.thinkingLevels?.get(state.agent?.model ?: catalog.default).orEmpty()
        EffortSheet(levels, state.agent?.thinkingLevel ?: "off", onDismiss = { effortSheet = false }, onSelect = { chat.setEffort(it); effortSheet = false })
    }
}

@Composable
private fun TranscriptRow(
    item: TranscriptItem,
    state: ChatUiState,
    api: ReiApi,
    sessionId: String,
    agentName: String,
    outcomes: Map<String, String>,
    chat: ChatViewModel,
    onLongPress: (Message) -> Unit,
    onInspectRun: (String) -> Unit,
    onInspectStep: (run: String, step: String) -> Unit,
    onCopy: (String) -> Unit,
    onOpenBrowser: () -> Unit,
    onOpenPage: (String) -> Unit,
) {
    val opener = LocalWorkspaceOpener.current
    when (item) {
        is TranscriptItem.User -> UserBubble(
            message = item.message,
            onLongPress = { onLongPress(item.message) },
            highlighted = state.focus == item.message.id,
            onOpenAttachment = { ref: AttachmentRef -> opener?.openFile(ref.fileId, ref.versionId) },
            onShowVersions = { onLongPress(item.message) },
        )
        is TranscriptItem.Reply -> {
            val message = item.message
            AssistantBubble(
                message = message,
                text = message.text,
                api = api,
                sessionId = sessionId,
                agentName = agentName,
                onLongPress = { onLongPress(message) },
                highlighted = state.focus == message.id,
                actions = if (message.status == "failed") null else ReplyActions(
                    onCopy = { onCopy(message.text) },
                    onInspect = message.runId?.let { run -> { onInspectRun(run) } },
                ),
                onContinue = if (message.status == "failed" && !state.busy) chat::continueRun else null,
                showDetails = state.showDetails,
            )
        }
        is TranscriptItem.Activity -> ToolActivityRow(
            run = item.run,
            detail = state.showDetails,
            outcomes = outcomes,
            waitingForApproval = state.waitingForAnswer && item.run.live,
            onInspect = { step -> onInspectStep(item.run.runId, step) },
            onOpenPage = onOpenPage,
        )
        is TranscriptItem.Approval -> item.message.approval?.let { approval ->
            ApprovalCard(approval = approval, onDecide = { approve, length, hours -> chat.decide(approval, approve, length, hours) }, agentName = agentName)
        }
        is TranscriptItem.Takeover -> item.message.takeover?.let { TakeoverCard(it, agentName, onOpen = onOpenBrowser) }
        is TranscriptItem.Notice -> NoticeLine(item.text.asString())
        is TranscriptItem.Pending -> PendingBubble(
            text = item.send.text,
            attachments = item.send.attachments,
            failed = item.send.failed,
            error = item.send.error?.asString(),
            onRetry = chat::retrySend,
            onDiscard = chat::discardPending,
        )
        is TranscriptItem.Streaming -> AssistantBubble(
            message = null,
            text = item.text,
            api = api,
            sessionId = sessionId,
            agentName = agentName,
            onLongPress = {},
            streaming = true,
        )
        TranscriptItem.Thinking -> ThinkingLine(agentName)
    }
}

@Composable
private fun ChatTopBar(
    state: ChatUiState,
    scrolled: Boolean,
    chat: ChatViewModel,
    onInspect: () -> Unit,
    onOpenBrowser: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf("") }
    val session = state.detail?.session ?: state.session
    // The agent's home chat is the agent itself: it cannot be renamed, pinned or deleted.
    val manageable = session != null && session.origin != "home"
    ReiTopBar(
        title = state.title.ifBlank { stringResource(R.string.chat_title) },
        subtitle = state.agent?.name?.takeUnless { it.equals(state.title, ignoreCase = true) },
        scrolled = scrolled,
        leading = state.agent?.let { agent -> { AgentAvatar(agent.avatar, size = 36.dp, working = state.busy) } },
        actions = {
            ReiIconButton(ReiIcons.MoreVertical, stringResource(R.string.chat_options), { menu = true })
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (manageable && session != null) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.drawer_chat_rename)) },
                        leadingIcon = { Icon(ReiIcons.Edit, null) },
                        onClick = { menu = false; title = session.title; renaming = true },
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(if (session.pinned) R.string.drawer_chat_unpin else R.string.drawer_chat_pin)) },
                        leadingIcon = { Icon(ReiIcons.Pin, null) },
                        onClick = { menu = false; chat.pin(!session.pinned) },
                    )
                }
                val showDetailsDesc = stringResource(if (state.showDetails) R.string.chat_switch_on else R.string.chat_switch_off)
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_show_details)) },
                    leadingIcon = { Icon(ReiIcons.Sliders, null) },
                    trailingIcon = { Switch(checked = state.showDetails, onCheckedChange = null) },
                    modifier = Modifier.semantics {
                        role = Role.Switch
                        toggleableState = ToggleableState(state.showDetails)
                        stateDescription = showDetailsDesc
                    },
                    onClick = { chat.setShowDetails(!state.showDetails) },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_inspect_title)) },
                    leadingIcon = { Icon(ReiIcons.Eye, null) },
                    onClick = { menu = false; onInspect() },
                )
                if (session?.hasBrowser == true) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_live_browser)) },
                        leadingIcon = { Icon(ReiIcons.Globe, null) },
                        onClick = { menu = false; onOpenBrowser() },
                    )
                }
                if (manageable) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) },
                        leadingIcon = { Icon(ReiIcons.Trash, null, tint = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; deleting = true },
                    )
                }
            }
        },
    )
    if (renaming) {
        AlertDialog(
            onDismissRequest = { renaming = false },
            shape = ReiShapes.Dialog,
            containerColor = ReiTheme.colors.card,
            title = { Text(stringResource(R.string.drawer_chat_rename_title)) },
            text = { ReiTextField(title, { title = it }, label = stringResource(R.string.drawer_chat_title_label), singleLine = true) },
            dismissButton = { TextButton({ renaming = false }) { Text(stringResource(R.string.common_cancel)) } },
            confirmButton = { TextButton({ chat.rename(title.trim()); renaming = false }, enabled = title.isNotBlank()) { Text(stringResource(R.string.common_save)) } },
        )
    }
    if (deleting) {
        ConfirmDialog(
            title = stringResource(R.string.drawer_chat_delete_title),
            text = stringResource(R.string.chat_delete_body),
            confirmLabel = stringResource(R.string.common_delete),
            onConfirm = { chat.delete(); deleting = false },
            onDismiss = { deleting = false },
            destructive = true,
        )
    }
}

/** A new chat: the agent's avatar and name. The protocol carries no description or suggestions, so none are shown. */
@Composable
private fun EmptyChat(state: ChatUiState) {
    val agent = state.agent
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (agent != null) AgentAvatar(agent.avatar, size = 72.dp, name = agent.name)
        Text(
            agent?.name ?: stringResource(R.string.app_name),
            Modifier.padding(top = 16.dp),
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.chat_empty_subtitle),
            Modifier.padding(top = 4.dp),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun JumpToLatest(newContent: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val jumpLabel = stringResource(if (newContent) R.string.chat_jump_latest_new else R.string.chat_jump_latest)
    Box(modifier) {
        Surface(
            onClick = onClick,
            shape = CircleShape,
            color = colors.surfaceContainerHigh,
            contentColor = colors.onSurface,
            border = BorderStroke(1.dp, colors.outlineVariant),
            shadowElevation = 2.dp,
            modifier = Modifier.size(48.dp).semantics { contentDescription = jumpLabel },
        ) {
            Box(contentAlignment = Alignment.Center) { Icon(ReiIcons.Down, null) }
        }
        if (newContent) {
            Box(Modifier.align(Alignment.TopEnd).padding(4.dp).size(10.dp).background(colors.primary, CircleShape))
        }
    }
}

@Composable
internal fun ChatEmptyContent(historyLoaded: Boolean, onNewChat: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize()) {
        ReiTopBar(stringResource(R.string.chat_title))
        EmptyState(
            icon = ReiIcons.Compose,
            title = stringResource(if (historyLoaded) R.string.chat_empty_none_title else R.string.chat_empty_loading_title),
            body = if (historyLoaded) stringResource(R.string.chat_empty_none_body) else null,
            action = if (historyLoaded) {
                { Button(onClick = onNewChat, shape = ReiShapes.Pill) { Text(stringResource(R.string.drawer_new_chat)) } }
            } else null,
        )
    }
}

@ReiPreviews
@Composable
private fun ChatEmptyPreview() = ReiScreenPreviewSurface {
    ChatEmptyContent(historyLoaded = true, onNewChat = {})
}
