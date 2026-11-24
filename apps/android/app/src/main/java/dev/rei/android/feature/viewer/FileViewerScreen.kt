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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.ReiViewModel
import dev.rei.android.data.LibraryDetail
import dev.rei.android.data.LibraryVersion
import dev.rei.android.data.ReiApi
import dev.rei.android.data.WorkspaceChanges
import dev.rei.android.data.setFileTrashed
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.ZoomableImage
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.tabular
import java.text.DateFormat
import java.util.Date

/** The full-screen viewer for one Library file. [versionId] pins a version (a chat attachment); [onClose] leaves it. */
@Composable
fun FileViewerScreen(model: ReiViewModel, api: ReiApi, fileId: String, versionId: String?, onClose: () -> Unit) {
    val vm: FileViewerViewModel = viewModel(factory = FileViewerViewModel.factory(model))
    LaunchedEffect(fileId, versionId) { vm.open(fileId, versionId) }
    DisposableEffect(vm) { onDispose { vm.forget() } }
    BackHandler(onBack = onClose)
    val state by vm.state.collectAsStateWithLifecycle()
    val notices = LocalNotices.current
    val context = LocalContext.current
    var pendingDownload by remember { mutableStateOf<LibraryVersion?>(null) }
    val saver = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val version = pendingDownload
        pendingDownload = null
        if (uri != null && version != null) {
            vm.download(
                context.contentResolver, uri, version,
                done = { notices?.show("Saved $it") },
                failed = { notices?.show("Download failed: $it") },
            )
        }
    }
    fun download(version: LibraryVersion) { pendingDownload = version; saver.launch(version.name) }

    var info by remember { mutableStateOf(false) }
    var history by remember { mutableStateOf(false) }
    var confirmTrash by remember { mutableStateOf(false) }

    FileViewerContent(
        state = state,
        api = api,
        onBack = onClose,
        onInfo = { info = true },
        onHistory = { history = true },
        onDownload = { state.shown?.let(::download) },
        onTrash = { confirmTrash = true },
        onRestore = {
            vm.setTrashed(false, done = { notices?.show("Restored $it") }, failed = { notices?.show(it) })
        },
        onRetry = { if (state.detail == null) vm.retry() else vm.reload() },
        onCompatibility = vm::toggleCompatibility,
        onShowLatest = vm::showLatest,
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
    if (confirmTrash) {
        ConfirmDialog(
            title = "Move to Trash?",
            text = "“${state.file?.name.orEmpty()}” will leave the Library. You can restore it from Trash.",
            confirmLabel = "Move to Trash",
            destructive = true,
            onConfirm = {
                confirmTrash = false
                vm.setTrashed(
                    true,
                    done = { name ->
                        onClose()
                        notices?.show("Moved “$name” to Trash", "Undo") {
                            notices.launch {
                                try {
                                    api.setFileTrashed(fileId, false)
                                    WorkspaceChanges.filesChanged()
                                } catch (failure: kotlinx.coroutines.CancellationException) {
                                    throw failure
                                } catch (failure: Exception) {
                                    notices.show(failure.localizedMessage ?: "Could not restore the file.")
                                }
                            }
                        }
                    },
                    failed = { notices?.show(it) },
                )
            },
            onDismiss = { confirmTrash = false },
        )
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
    Column(modifier.fillMaxSize()) {
        ReiTopBar(
            title = state.file?.name ?: "File",
            subtitle = state.shown?.let { "${fileBytes(it.size)} · v${it.number}" },
            onBack = onBack,
            actions = {
                ReiIconButton(ReiIcons.Info, "Info", onInfo, enabled = ready)
                ReiIconButton(ReiIcons.History, "History", onHistory, enabled = ready)
                ReiIconButton(ReiIcons.Download, "Download", onDownload, enabled = ready && !state.working)
                if (trashed) ReiIconButton(ReiIcons.Undo, "Restore", onRestore)
                else ReiIconButton(ReiIcons.Trash, "Move to Trash", onTrash, enabled = ready)
            },
        )
        if (state.working) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (trashed) StatusBanner("This file is in Trash.", modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        if (state.detail != null && !state.isLatest) {
            StatusBanner(
                "Viewing version ${state.shown?.number} of ${state.detail.versions.size}.",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                actionLabel = "Show latest",
                onAction = onShowLatest,
            )
        }
        val shown = state.shown
        if (shown != null && previewKind(shown.name, shown.mediaType) == PreviewKind.Office) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                FilterChip(state.compatibility, onCompatibility, { Text("Compatibility preview") })
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.error != null -> EmptyState(ReiIcons.Alert, "Couldn’t open this file", body = state.error) {
                    OutlinedButton(onRetry) { Text("Try again") }
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
        is ViewerContent.Picture -> ZoomableImage(content.bitmap, name.ifBlank { "Image" })
        is ViewerContent.Document -> DocumentWebView(content.bytes, content.name)
        is ViewerContent.Unavailable -> EmptyState(ReiIcons.File, "No preview", body = content.message) {
            if (content.retry) OutlinedButton(onRetry) { Text("Try again") }
            else OutlinedButton(onDownload) { Text("Download") }
        }
        is ViewerContent.Words -> Column(Modifier.fillMaxSize()) {
            if (content.truncated) {
                StatusBanner("Showing the first 1 MiB. Download the file to read all of it.", modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            if (content.markdown && api != null) {
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp)) {
                    ReiMarkdown(content.text, api)
                }
            } else {
                val lines = remember(content.text) { content.text.lines() }
                SelectionContainer(Modifier.weight(1f)) {
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp)) {
                        items(lines) { line ->
                            Text(line.ifEmpty { " " }, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
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
    ReiSheet(onDismiss = onDismiss, title = file.name) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SettingsGroup {
                SettingsRow(
                    "Favorite",
                    icon = ReiIcons.Star,
                    dividerBelow = true,
                    onClick = onFavorite,
                    trailing = { Switch(file.favorite, onCheckedChange = null) },
                )
                SettingsRow("Type", summary = version.mediaType.ifBlank { "Unknown" }, dividerBelow = true)
                SettingsRow("Size", summary = fileBytes(version.size), dividerBelow = true)
                SettingsRow("Version", summary = "${version.number} of ${detail.versions.size.coerceAtLeast(1)}", dividerBelow = true)
                SettingsRow("Created", summary = dateTime(file.createdAt), dividerBelow = true)
                SettingsRow("Updated", summary = dateTime(file.updatedAt), dividerBelow = true)
                SettingsRow("Origin", summary = if (file.origin == "agent") "Created by an agent" else "Uploaded", dividerBelow = file.creator.isNotBlank() || detail.folderName != null || detail.chats.isNotEmpty())
                if (file.creator.isNotBlank()) SettingsRow("Creator", summary = file.creator, dividerBelow = detail.folderName != null || detail.chats.isNotEmpty())
                detail.folderName?.let { SettingsRow("Folder", summary = it, dividerBelow = detail.chats.isNotEmpty()) }
                if (detail.chats.isNotEmpty()) {
                    SettingsRow("Used in", summary = detail.chats.joinToString { it.second.ifBlank { "Untitled chat" } })
                }
            }
        }
    }
}

@Composable
private fun HistorySheet(detail: LibraryDetail, shownId: String?, onPreview: (LibraryVersion) -> Unit, onDownload: (LibraryVersion) -> Unit, onDismiss: () -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = "History") {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            SettingsGroup {
                detail.versions.forEachIndexed { index, version ->
                    val current = version.versionId == detail.file.current.versionId
                    SettingsRow(
                        "Version ${version.number}${if (current) " · Current" else ""}",
                        summary = buildString {
                            append(dateTime(version.createdAt)).append(" · ").append(fileBytes(version.size))
                            if (version.creator.isNotBlank()) append(" · ").append(version.creator)
                        },
                        dividerBelow = index != detail.versions.lastIndex,
                        onClick = { onPreview(version) },
                        trailing = {
                            Row {
                                ReiIconButton(ReiIcons.Eye, "Preview version ${version.number}", { onPreview(version) }, toggled = version.versionId == shownId)
                                ReiIconButton(ReiIcons.Download, "Download version ${version.number}", { onDownload(version) })
                            }
                        },
                    )
                }
            }
        }
    }
}

private fun dateTime(millis: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(millis))
