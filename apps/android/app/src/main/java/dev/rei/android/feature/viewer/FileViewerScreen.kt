package dev.rei.android.feature.viewer

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.window.core.layout.WindowSizeClass
import dev.rei.android.R
import dev.rei.android.data.LibraryDetail
import dev.rei.android.data.LibraryVersion
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.ZoomableImage
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.tabular
import java.text.DateFormat
import java.util.Date

/** The full-screen viewer for one Library file. [versionId] pins a version (a chat attachment); [onClose] leaves it. */
@Composable
fun FileViewerScreen(container: AppContainer, api: ReiApi, fileId: String, versionId: String?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val vm: FileViewerViewModel = viewModel(factory = FileViewerViewModel.factory(fileId, versionId, container))
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        vm.completeDownload(context.contentResolver, uri)
    }
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                ViewerEvent.Close -> onClose()
            }
        }
    }
    fun download(version: LibraryVersion) { saver.launch(vm.prepareDownload(version)) }

    var info by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }

    FileViewerContent(
        state = state,
        api = api,
        onBack = onClose,
        onInfo = { info = true },
        onHistory = { history = true },
        onDownload = { state.shown?.let(::download) },
        onTrash = { vm.setTrashed(true) },
        onRestore = { vm.setTrashed(false) },
        onRetry = { if (state.detail == null) vm.retry() else vm.reload() },
        onCompatibility = vm::toggleCompatibility,
        onShowLatest = vm::showLatest,
        modifier = modifier,
    )
    if (info) {
        state.detail?.let { InfoSheet(it, state.shown, onFavorite = vm::toggleFavorite, onDismiss = { info = false }) }
    }
    if (history) {
        state.detail?.let { detail ->
            HistorySheet(
                detail,
                shownId = state.shown?.versionId,
                onPreview = { vm.showVersion(it); history = false },
                onDownload = { history = false; download(it) },
                onDismiss = { history = false },
            )
        }
    }
}

/** Stateless viewer: top bar with the four actions, then the previewed content. */
@Composable
fun FileViewerContent(
    state: ViewerUiState,
    api: ReiApi?,
    onBack: () -> Unit,
    onInfo: () -> Unit,
    onHistory: () -> Unit,
    onDownload: () -> Unit,
    onTrash: () -> Unit,
    onRestore: () -> Unit,
    onRetry: () -> Unit,
    onCompatibility: () -> Unit,
    onShowLatest: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ready = state.detail != null
    val trashed = state.file?.trashed == true
    val compact = !currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND)
    var menu by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize()) {
        ReiTopBar(
            title = state.file?.name ?: stringResource(R.string.viewer_title_fallback),
            subtitle = state.shown?.let { stringResource(R.string.viewer_subtitle, fileBytes(it.size), it.number) },
            onBack = onBack,
            actions = {
                ReiIconButton(ReiIcons.Info, stringResource(R.string.viewer_info), onInfo, enabled = ready)
                if (!compact) ReiIconButton(ReiIcons.History, stringResource(R.string.viewer_history), onHistory, enabled = ready)
                ReiIconButton(ReiIcons.Download, stringResource(R.string.viewer_download), onDownload, enabled = ready && !state.working)
                if (trashed) {
                    ReiIconButton(ReiIcons.Undo, stringResource(R.string.knowledge_restore), onRestore)
                } else if (!compact) {
                    ReiIconButton(ReiIcons.Trash, stringResource(R.string.knowledge_page_move_to_trash), onTrash, enabled = ready)
                }
                if (compact) {
                    Box {
                        ReiIconButton(ReiIcons.MoreVertical, stringResource(R.string.viewer_options), { menu = true }, enabled = ready)
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.viewer_history)) },
                                leadingIcon = { Icon(ReiIcons.History, null) },
                                enabled = ready,
                                onClick = { menu = false; onHistory() },
                            )
                            if (!trashed) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.knowledge_page_move_to_trash), color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(ReiIcons.Trash, null, tint = MaterialTheme.colorScheme.error) },
                                    enabled = ready,
                                    onClick = { menu = false; onTrash() },
                                )
                            }
                        }
                    }
                }
            },
        )
        if (state.working) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (trashed) StatusBanner(stringResource(R.string.viewer_in_trash), modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        if (state.detail != null && !state.isLatest) {
            StatusBanner(
                stringResource(R.string.viewer_old_version, state.shown?.number ?: 0, state.detail.versions.size),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                actionLabel = stringResource(R.string.viewer_show_latest),
                onAction = onShowLatest,
            )
        }
        val shown = state.shown
        if (shown != null && previewKind(shown.name, shown.mediaType) == PreviewKind.Office) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                FilterChip(state.compatibility, onCompatibility, { Text(stringResource(R.string.viewer_compat_preview)) })
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.error != null -> EmptyState(ReiIcons.Alert, stringResource(R.string.viewer_open_failed_title), body = state.error.asString()) {
                    OutlinedButton(onRetry) { Text(stringResource(R.string.common_try_again)) }
                }
                else -> ViewerBody(state.content, api, shown?.name.orEmpty(), onRetry, onDownload)
            }
        }
    }
}

@Composable
private fun ViewerBody(content: ViewerContent, api: ReiApi?, name: String, onRetry: () -> Unit, onDownload: () -> Unit) {
    when (content) {
        ViewerContent.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
        }
        is ViewerContent.Picture -> ZoomableImage(content.bitmap, name.ifBlank { stringResource(R.string.viewer_image_fallback) })
        is ViewerContent.Document -> DocumentWebView(content.bytes, content.name)
        is ViewerContent.Unavailable -> EmptyState(ReiIcons.File, stringResource(R.string.viewer_no_preview), body = content.message.asString()) {
            if (content.retry) OutlinedButton(onRetry) { Text(stringResource(R.string.common_try_again)) }
            else OutlinedButton(onDownload) { Text(stringResource(R.string.viewer_download)) }
        }
        is ViewerContent.Words -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 760.dp).fillMaxSize()) {
                if (content.truncated) {
                    StatusBanner(stringResource(R.string.viewer_truncated), modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                }
                if (content.markdown && api != null) {
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp)) {
                        ReiMarkdown(content.text, api)
                    }
                } else {
                    val lines = remember(content.text) { content.text.lines() }
                    SelectionContainer(Modifier.weight(1f)) {
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
                            itemsIndexed(lines, key = { index, _ -> "line-$index" }, contentType = { _, _ -> "line" }) { _, line ->
                                Text(line.ifEmpty { " " }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InfoSheet(detail: LibraryDetail, shown: LibraryVersion?, onFavorite: () -> Unit, onDismiss: () -> Unit) {
    val file = detail.file
    val version = shown ?: file.current
    val untitledChat = stringResource(R.string.viewer_info_untitled_chat)
    ReiSheet(onDismiss = onDismiss, title = file.name) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SettingsGroup {
                SettingsSwitchRow(
                    stringResource(R.string.library_file_favorite),
                    file.favorite,
                    { onFavorite() },
                    icon = ReiIcons.Star,
                    dividerBelow = true,
                )
                SettingsRow(stringResource(R.string.viewer_info_type), summary = version.mediaType.ifBlank { stringResource(R.string.viewer_info_type_unknown) }, dividerBelow = true)
                SettingsRow(stringResource(R.string.viewer_info_size), summary = fileBytes(version.size), dividerBelow = true)
                SettingsRow(stringResource(R.string.viewer_info_version), summary = stringResource(R.string.viewer_info_version_value, version.number, detail.versions.size.coerceAtLeast(1)), dividerBelow = true)
                SettingsRow(stringResource(R.string.viewer_info_created), summary = dateTime(file.createdAt), dividerBelow = true)
                SettingsRow(stringResource(R.string.viewer_info_updated), summary = dateTime(file.updatedAt), dividerBelow = true)
                SettingsRow(
                    stringResource(R.string.viewer_info_origin),
                    summary = stringResource(if (file.origin == "agent") R.string.viewer_info_origin_agent else R.string.viewer_info_origin_upload),
                    dividerBelow = file.creator.isNotBlank() || detail.folderName != null || detail.chats.isNotEmpty(),
                )
                if (file.creator.isNotBlank()) SettingsRow(stringResource(R.string.viewer_info_creator), summary = file.creator, dividerBelow = detail.folderName != null || detail.chats.isNotEmpty())
                detail.folderName?.let { SettingsRow(stringResource(R.string.viewer_info_folder), summary = it, dividerBelow = detail.chats.isNotEmpty()) }
                if (detail.chats.isNotEmpty()) {
                    SettingsRow(stringResource(R.string.viewer_info_used_in), summary = detail.chats.joinToString { it.second.ifBlank { untitledChat } })
                }
            }
        }
    }
}

@Composable
private fun HistorySheet(detail: LibraryDetail, shownId: String?, onPreview: (LibraryVersion) -> Unit, onDownload: (LibraryVersion) -> Unit, onDismiss: () -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.viewer_history)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            SettingsGroup {
                detail.versions.forEachIndexed { index, version ->
                    val current = version.versionId == detail.file.current.versionId
                    SettingsRow(
                        stringResource(if (current) R.string.viewer_history_version_current else R.string.viewer_history_version, version.number),
                        summary = buildString {
                            append(dateTime(version.createdAt)).append(" · ").append(fileBytes(version.size))
                            if (version.creator.isNotBlank()) append(" · ").append(version.creator)
                        },
                        dividerBelow = index != detail.versions.lastIndex,
                        onClick = { onPreview(version) },
                        trailing = {
                            Row {
                                ReiIconButton(ReiIcons.Eye, stringResource(R.string.viewer_history_preview_version, version.number), { onPreview(version) }, toggled = version.versionId == shownId)
                                ReiIconButton(ReiIcons.Download, stringResource(R.string.viewer_history_download_version, version.number), { onDownload(version) })
                            }
                        },
                    )
                }
            }
        }
    }
}

private fun dateTime(millis: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))
