package dev.rei.android.feature.library

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.ReiViewModel
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.LibrarySort
import dev.rei.android.data.LibraryTab
import dev.rei.android.data.ReiApi
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.components.workspace.ActiveFilter
import dev.rei.android.ui.components.workspace.ReiFab
import dev.rei.android.ui.components.workspace.WorkspaceHeader
import dev.rei.android.ui.components.workspace.fabExpanded
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.MotionRegion
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.arrive
import dev.rei.android.ui.theme.tabular

private val FilterTypes = listOf("image" to "Images", "pdf" to "PDF", "office" to "Office", "markdown" to "Markdown", "text" to "Text", "csv" to "CSV", "html" to "HTML", "audio" to "Audio", "video" to "Video")
private val FilterOrigins = listOf("upload" to "Uploaded", "agent" to "Agent-created")

/** The Library destination: loads through [LibraryViewModel], opens files through [onOpen] (the shell's viewer). */
@Composable
fun LibraryScreen(model: ReiViewModel, api: ReiApi, onOpen: (LibraryFile) -> Unit) {
    val vm: LibraryViewModel = viewModel(factory = LibraryViewModel.factory(model))
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        vm.upload(context.contentResolver, uris)
    }
    LibraryContent(
        state = state,
        api = api,
        onText = vm::setText,
        onTab = vm::setTab,
        onType = vm::setType,
        onOrigin = vm::setOrigin,
        onSort = vm::setSort,
        onResetFilters = vm::clearFilters,
        onOpen = onOpen,
        onRefresh = { vm.refresh() },
        onLoadMore = vm::loadMore,
        onRetry = vm::retry,
        onUpload = { picker.launch(arrayOf("*/*")) },
        onDismissError = vm::dismissError,
    )
}

/** Stateless Library: everything it shows comes from [state], so it previews and tests without a view model. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryContent(
    state: LibraryUiState,
    api: ReiApi?,
    onText: (String) -> Unit,
    onTab: (LibraryTab) -> Unit,
    onType: (String) -> Unit,
    onOrigin: (String) -> Unit,
    onSort: (LibrarySort) -> Unit,
    onResetFilters: () -> Unit,
    onOpen: (LibraryFile) -> Unit,
    onRefresh: () -> Unit,
    onLoadMore: () -> Unit,
    onRetry: () -> Unit,
    onUpload: () -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val gridState = rememberLazyGridState()
    var sheet by remember { mutableStateOf(false) }
    val scrolled by remember { derivedStateOf { gridState.firstVisibleItemIndex > 0 || gridState.firstVisibleItemScrollOffset > 0 } }
    val query = state.query
    val filters = buildList {
        if (query.tab != LibraryTab.All) add(ActiveFilter(query.tab.label) { onTab(LibraryTab.All) })
        FilterTypes.firstOrNull { it.first == query.type }?.let { add(ActiveFilter(it.second) { onType("") }) }
        FilterOrigins.firstOrNull { it.first == query.origin }?.let { add(ActiveFilter(it.second) { onOrigin("") }) }
    }
    // Reaching the last loaded rows asks for the next page.
    val nearEnd by remember { derivedStateOf { gridState.layoutInfo.let { it.visibleItemsInfo.lastOrNull()?.index ?: 0 } >= gridState.layoutInfo.totalItemsCount - 4 } }
    LaunchedEffect(nearEnd, state.nextCursor, state.files.size) { if (nearEnd && state.nextCursor != null && state.files.isNotEmpty()) onLoadMore() }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ReiTopBar("", scrolled = scrolled)
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
                MotionRegion(key = Triple(query.tab, query.type, query.origin), ready = state.loaded) {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(156.dp),
                        state = gridState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                WorkspaceHeader(
                                    title = "Library",
                                    query = state.searchText,
                                    onQuery = onText,
                                    searchLabel = "Search library",
                                    onFilter = { sheet = true },
                                    filters = filters,
                                                                    )
                                state.upload?.let { upload ->
                                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        StatusBanner("Uploading ${upload.name} (${upload.index} of ${upload.total})…")
                                        LinearProgressIndicator(Modifier.fillMaxWidth())
                                    }
                                }
                                (state.uploadError ?: state.error?.takeIf { state.files.isNotEmpty() })?.let { message ->
                                    StatusBanner(message, kind = StatusKind.Error, actionLabel = "Dismiss", onAction = onDismissError)
                                }
                            }
                        }
                        if (!state.loaded) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp) }
                            }
                        } else if (state.files.isEmpty()) {
                            item(span = { GridItemSpan(maxLineSpan) }) { LibraryEmpty(state, onResetFilters, onRetry, onUpload) }
                        }
                        items(state.files, key = { it.id }) { file ->
                            FileCard(file, api, onOpen = { onOpen(file) }, modifier = Modifier.arrive(ReiEnter.Fade))
                        }
                        if (state.loadingMore) {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                            }
                        }
                    }
                }
            }
        }
        if (query.tab != LibraryTab.Trash) {
            ReiFab("Upload", ReiIcons.Upload, onUpload, expanded = gridState.fabExpanded(), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
        }
    }
    if (sheet) {
        LibraryFilterSheet(
            state = state,
            onTab = onTab,
            onType = onType,
            onOrigin = onOrigin,
            onSort = onSort,
            onReset = onResetFilters,
            onDismiss = { sheet = false },
        )
    }
}

@Composable
private fun LibraryEmpty(state: LibraryUiState, onReset: () -> Unit, onRetry: () -> Unit, onUpload: () -> Unit) {
    val query = state.query
    when {
        state.loadFailed -> EmptyState(ReiIcons.Alert, "Couldn’t load files", body = state.error ?: "Try loading your files again.") {
            OutlinedButton(onRetry) { Text("Try again") }
        }
        query.filtered -> EmptyState(ReiIcons.Search, "No matching files", body = "Try another search or clear your filters.") {
            OutlinedButton(onReset) { Text("Clear filters") }
        }
        query.tab == LibraryTab.Trash -> EmptyState(ReiIcons.Trash, "Trash is empty", body = "Files you move to Trash stay here for 30 days.")
        query.tab == LibraryTab.Favorites -> EmptyState(ReiIcons.Star, "No favorites yet", body = "Favorite a file from its info to find it here.")
        else -> EmptyState(ReiIcons.Library, "No files here yet", body = "Files you upload or that agents save appear here.") {
            OutlinedButton(onUpload) { Text("Upload files") }
        }
    }
}

@Composable
private fun LibraryFilterSheet(
    state: LibraryUiState,
    onTab: (LibraryTab) -> Unit,
    onType: (String) -> Unit,
    onOrigin: (String) -> Unit,
    onSort: (LibrarySort) -> Unit,
    onReset: () -> Unit,
    onDismiss: () -> Unit,
) {
    val query = state.query
    ReiSheet(onDismiss = onDismiss, title = "Filters") {
        Column(Modifier.padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterGroup("Show") {
                LibraryTab.entries.forEach { tab -> FilterChip(query.tab == tab, { onTab(tab) }, { Text(tab.label) }) }
            }
            FilterGroup("Type") {
                FilterTypes.forEach { (value, label) -> FilterChip(query.type == value, { onType(if (query.type == value) "" else value) }, { Text(label) }) }
            }
            FilterGroup("Origin") {
                FilterOrigins.forEach { (value, label) -> FilterChip(query.origin == value, { onOrigin(if (query.origin == value) "" else value) }, { Text(label) }) }
            }
            Text("Sort by", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column {
                LibrarySort.entries.forEach { sort ->
                    Row(
                        Modifier.fillMaxWidth().selectable(query.sort == sort, role = Role.RadioButton) { onSort(sort) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(query.sort == sort, onClick = null)
                        Text(sort.label, Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onReset, enabled = query.filtered || query.tab != LibraryTab.All) { Text("Reset filters") }
            }
        }
    }
}

@Composable
private fun FilterGroup(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
    }
}

@ReiPreviews
@Composable
private fun LibraryEmptyPreview() = ReiPreviewSurface {
    Text("Files you upload or that agents save appear here.", style = MaterialTheme.typography.bodyMedium.tabular())
}
