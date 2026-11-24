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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.R
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.LibrarySort
import dev.rei.android.data.LibraryTab
import dev.rei.android.data.LibraryVersion
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.ReiScreenPreviewSurface
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

private val FilterTypes = listOf(
    "image" to R.string.library_type_image,
    "pdf" to R.string.library_type_pdf,
    "office" to R.string.library_type_office,
    "markdown" to R.string.library_type_markdown,
    "text" to R.string.library_type_text,
    "csv" to R.string.library_type_csv,
    "html" to R.string.library_type_html,
    "audio" to R.string.library_type_audio,
    "video" to R.string.library_type_video,
)
private val FilterOrigins = listOf("upload" to R.string.library_origin_upload, "agent" to R.string.library_origin_agent)

/** The Library destination: loads through [LibraryViewModel], opens files through [onOpen] (the shell's viewer). */
@Composable
fun LibraryScreen(container: AppContainer, api: ReiApi, onOpen: (LibraryFile) -> Unit, modifier: Modifier = Modifier) {
    val vm: LibraryViewModel = viewModel(factory = LibraryViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val defaultAttachmentName = stringResource(R.string.upload_default_name)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        vm.upload(context.contentResolver, uris, defaultAttachmentName)
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
        modifier = modifier,
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
    val context = LocalContext.current
    val query = state.query
    val filters = buildList {
        if (query.tab != LibraryTab.All) add(ActiveFilter(stringResource(query.tab.labelRes)) { onTab(LibraryTab.All) })
        FilterTypes.firstOrNull { it.first == query.type }?.let { add(ActiveFilter(stringResource(it.second)) { onType("") }) }
        FilterOrigins.firstOrNull { it.first == query.origin }?.let { add(ActiveFilter(stringResource(it.second)) { onOrigin("") }) }
    }
    // Reaching the last loaded rows asks for the next page.
    val nearEnd by remember { derivedStateOf { gridState.layoutInfo.let { it.visibleItemsInfo.lastOrNull()?.index ?: 0 } >= gridState.layoutInfo.totalItemsCount - 4 } }
    LaunchedEffect(nearEnd, state.nextCursor, state.files.size) { if (nearEnd && state.nextCursor != null && state.files.isNotEmpty()) onLoadMore() }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ReiTopBar("", scrolledTitle = stringResource(R.string.library_title), scrolled = scrolled)
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
                        item(key = "header", span = { GridItemSpan(maxLineSpan) }, contentType = "header") {
                            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                WorkspaceHeader(
                                    title = stringResource(R.string.library_title),
                                    query = state.searchText,
                                    onQuery = onText,
                                    searchLabel = stringResource(R.string.library_search),
                                    onFilter = { sheet = true },
                                    filters = filters,
                                )
                                state.upload?.let { upload ->
                                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        StatusBanner(stringResource(R.string.library_uploading, upload.name, upload.index, upload.total))
                                        LinearProgressIndicator(Modifier.fillMaxWidth())
                                    }
                                }
                                val bannerMessage = when {
                                    state.uploadError.isNotEmpty() -> state.uploadError.joinToString("\n") { it.asString(context) }
                                    state.files.isNotEmpty() -> state.error?.asString(context)
                                    else -> null
                                }
                                bannerMessage?.let { message ->
                                    StatusBanner(message, kind = StatusKind.Error, actionLabel = stringResource(R.string.common_dismiss), onAction = onDismissError)
                                }
                            }
                        }
                        if (!state.loaded) {
                            item(key = "loading", span = { GridItemSpan(maxLineSpan) }, contentType = "loading") {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp) }
                            }
                        } else if (state.files.isEmpty()) {
                            item(key = "empty", span = { GridItemSpan(maxLineSpan) }, contentType = "empty") { LibraryEmpty(state, onResetFilters, onRetry, onUpload) }
                        }
                        items(state.files, key = { "file-${it.id}" }, contentType = { "file" }) { file ->
                            FileCard(file, api, onOpen = { onOpen(file) }, modifier = Modifier.arrive(ReiEnter.Fade))
                        }
                        if (state.loadingMore) {
                            item(key = "more", span = { GridItemSpan(maxLineSpan) }, contentType = "more") {
                                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                            }
                        }
                    }
                }
            }
        }
        if (query.tab != LibraryTab.Trash) {
            ReiFab(stringResource(R.string.library_upload_btn), ReiIcons.Upload, onUpload, expanded = gridState.fabExpanded(), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
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
    val context = LocalContext.current
    val query = state.query
    when {
        state.loadFailed -> EmptyState(ReiIcons.Alert, stringResource(R.string.library_empty_err_title), body = state.error?.asString(context) ?: stringResource(R.string.library_empty_err_body)) {
            OutlinedButton(onRetry) { Text(stringResource(R.string.common_try_again)) }
        }
        query.filtered -> EmptyState(ReiIcons.Search, stringResource(R.string.library_empty_no_match_title), body = stringResource(R.string.library_empty_no_match_body)) {
            OutlinedButton(onReset) { Text(stringResource(R.string.library_filters_clear)) }
        }
        query.tab == LibraryTab.Trash -> EmptyState(ReiIcons.Trash, stringResource(R.string.library_empty_trash_title), body = stringResource(R.string.library_empty_trash_body))
        query.tab == LibraryTab.Favorites -> EmptyState(ReiIcons.Star, stringResource(R.string.library_empty_favorites_title), body = stringResource(R.string.library_empty_favorites_body))
        else -> EmptyState(ReiIcons.Library, stringResource(R.string.library_empty_default_title), body = stringResource(R.string.library_empty_default_body)) {
            OutlinedButton(onUpload) { Text(stringResource(R.string.library_upload_files)) }
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
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.library_filters_title)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterGroup(stringResource(R.string.library_filters_show)) {
                LibraryTab.entries.forEach { tab -> FilterChip(query.tab == tab, { onTab(tab) }, { Text(stringResource(tab.labelRes)) }) }
            }
            FilterGroup(stringResource(R.string.library_filters_type)) {
                FilterTypes.forEach { (value, labelRes) -> FilterChip(query.type == value, { onType(if (query.type == value) "" else value) }, { Text(stringResource(labelRes)) }) }
            }
            FilterGroup(stringResource(R.string.library_filters_origin)) {
                FilterOrigins.forEach { (value, labelRes) -> FilterChip(query.origin == value, { onOrigin(if (query.origin == value) "" else value) }, { Text(stringResource(labelRes)) }) }
            }
            Text(stringResource(R.string.library_filters_sort_by), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.selectableGroup()) {
                LibrarySort.entries.forEach { sort ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(query.sort == sort, role = Role.RadioButton) { onSort(sort) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(query.sort == sort, onClick = null)
                        Text(stringResource(sort.labelRes), Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onReset, enabled = query.filtered || query.tab != LibraryTab.All) { Text(stringResource(R.string.library_filters_reset)) }
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
private fun LibraryContentPreview() = ReiScreenPreviewSurface {
    LibraryContent(
        state = LibraryUiState(
            loaded = true,
            files = listOf(
                LibraryFile(
                    id = "f1",
                    name = "architecture-notes.md",
                    origin = "upload",
                    creator = "user",
                    createdAt = 1_700_000_000_000L,
                    updatedAt = 1_700_000_000_000L,
                    favorite = true,
                    trashedAt = null,
                    current = LibraryVersion("f1", "v1", 2, "architecture-notes.md", "text/markdown", 48_200L, 1_700_000_000_000L, "user"),
                ),
            ),
        ),
        api = null,
        onText = {},
        onTab = {},
        onType = {},
        onOrigin = {},
        onSort = {},
        onResetFilters = {},
        onOpen = {},
        onRefresh = {},
        onLoadMore = {},
        onRetry = {},
        onUpload = {},
        onDismissError = {},
    )
}
