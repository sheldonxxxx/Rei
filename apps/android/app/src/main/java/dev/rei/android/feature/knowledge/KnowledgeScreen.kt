package dev.rei.android.feature.knowledge

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.data.KnowledgeHit
import dev.rei.android.data.KnowledgeNode
import dev.rei.android.di.AppContainer
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiIconButton
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
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.arrive
import dev.rei.android.ui.theme.tabular

/** The Knowledge destination. [onOpenPage] opens the page view; [onNewPage] opens an empty editor. */
@Composable
fun KnowledgeScreen(container: AppContainer, onOpenPage: (String) -> Unit, onNewPage: () -> Unit) {
    val vm: KnowledgeViewModel = viewModel(factory = KnowledgeViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    KnowledgeContent(
        state = state,
        onText = vm::setText,
        onTab = vm::setTab,
        onToggleTag = vm::toggleTag,
        onResetFilters = vm::clearFilters,
        onToggleExpanded = vm::toggleExpanded,
        onEnsureTags = vm::ensureTags,
        onOpen = onOpenPage,
        onRestore = vm::restore,
        onRefresh = { vm.refresh() },
        onRetry = vm::retry,
        onNewPage = onNewPage,
        onDismissError = vm::dismissError,
    )
}

/** Stateless Knowledge list: previews and tests drive it with a [KnowledgeUiState]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KnowledgeContent(
    state: KnowledgeUiState,
    onText: (String) -> Unit,
    onTab: (KnowledgeTab) -> Unit,
    onToggleTag: (String) -> Unit,
    onResetFilters: () -> Unit,
    onToggleExpanded: (String) -> Unit,
    onEnsureTags: (String) -> Unit,
    onOpen: (String) -> Unit,
    onRestore: (KnowledgeNode) -> Unit,
    onRefresh: () -> Unit,
    onRetry: () -> Unit,
    onNewPage: () -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState()
    var sheet by remember { mutableStateOf(false) }
    val scrolled by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0 } }
    val filters = buildList {
        if (state.tab != KnowledgeTab.All) add(ActiveFilter(state.tab.label) { onTab(KnowledgeTab.All) })
        state.selectedTags.forEach { tag -> add(ActiveFilter("#$tag") { onToggleTag(tag) }) }
    }
    val rows = state.rows

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ReiTopBar("", scrolledTitle = "Knowledge", scrolled = scrolled)
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
                MotionRegion(key = Triple(state.tab, state.selectedTags, state.searching), ready = state.loaded) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                        LazyColumn(Modifier.widthIn(max = 760.dp).fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 96.dp)) {
                        item {
                            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                WorkspaceHeader(
                                    title = "Knowledge",
                                    query = state.searchText,
                                    onQuery = onText,
                                    searchLabel = "Search knowledge",
                                    onFilter = { sheet = true },
                                    filters = filters,
                                )
                                state.error?.takeIf { state.loaded && !state.loadFailed }?.let { message ->
                                    StatusBanner(message, kind = StatusKind.Error, actionLabel = "Dismiss", onAction = onDismissError)
                                }
                            }
                        }
                        when {
                            !state.loaded -> item {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
                                }
                            }
                            state.loadFailed -> item {
                                EmptyState(ReiIcons.Alert, "Couldn’t load pages", body = state.error ?: "Try loading your pages again.") {
                                    OutlinedButton(onRetry) { Text("Try again") }
                                }
                            }
                            state.searching -> {
                                if (state.hits.isEmpty()) item { KnowledgeEmpty(state, onResetFilters, onNewPage) }
                                else items(state.hits, key = { it.pageId + it.section }) { hit ->
                                    HitRow(hit, onOpen = { onOpen(hit.pageId) }, Modifier.arrive(ReiEnter.Fade))
                                }
                            }
                            rows.isEmpty() -> item { KnowledgeEmpty(state, onResetFilters, onNewPage) }
                            else -> items(rows, key = { it.node.id }) { row ->
                                LaunchedEffect(row.node.id) { onEnsureTags(row.node.id) }
                                PageRow(
                                    row = row,
                                    tags = state.tags[row.node.id].orEmpty(),
                                    trash = state.tab == KnowledgeTab.Trash,
                                    onOpen = { onOpen(row.node.id) },
                                    onToggle = { onToggleExpanded(row.node.id) },
                                    onRestore = { onRestore(row.node) },
                                    modifier = Modifier.arrive(ReiEnter.Fade),
                                )
                            }
                        }
                    }
                    }
                }
            }
        }
        if (state.tab != KnowledgeTab.Trash) {
            ReiFab("New page", ReiIcons.Plus, onNewPage, expanded = listState.fabExpanded(), modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp))
        }
    }
    if (sheet) KnowledgeFilterSheet(state, onTab, onToggleTag, onResetFilters) { sheet = false }
}

@Composable
private fun PageRow(
    row: KnowledgeRow,
    tags: List<String>,
    trash: Boolean,
    onOpen: () -> Unit,
    onToggle: () -> Unit,
    onRestore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val node = row.node
    val context = LocalContext.current
    val updated = remember(node.updatedAt) { relative(context, node.updatedAt) }
    Column(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp)
                .clickable(role = Role.Button, onClick = onOpen)
                .padding(start = (16 + 20 * row.depth).dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (!trash && node.childCount > 0) {
                ReiIconButton(
                    ReiIcons.Chevron,
                    if (row.expanded) "Collapse ${node.title}" else "Expand ${node.title}",
                    onToggle,
                    modifier = Modifier.rotate(if (row.expanded) 0f else -90f),
                    iconSize = 20.dp,
                )
            } else {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    Icon(ReiIcons.Page, null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
                }
            }
            Column(Modifier.weight(1f).padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(node.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (node.pinned) Icon(ReiIcons.Star, "Favorite", Modifier.size(14.dp), tint = colors.tertiary)
                    if (node.locked) Icon(ReiIcons.Lock, "Locked", Modifier.size(14.dp), tint = colors.onSurfaceVariant)
                }
                if (node.description.isNotBlank()) {
                    Text(node.description, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (tags.isNotEmpty()) TagLine(tags)
                Text(updated, style = MaterialTheme.typography.labelSmall.tabular(), color = colors.onSurfaceVariant)
            }
            if (trash) TextButton(onRestore, modifier = Modifier.semantics { contentDescription = "Restore ${node.title}" }) { Text("Restore") }
        }
        HorizontalDivider(Modifier.padding(start = 16.dp), color = colors.outlineVariant)
    }
}

@Composable
private fun TagLine(tags: List<String>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), maxLines = 2) {
        tags.forEach { tag ->
            Surface(shape = ReiShapes.Pill, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                Text("#$tag", Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
        }
    }
}

@Composable
private fun HitRow(hit: KnowledgeHit, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Column(modifier) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button, onClick = onOpen).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(hit.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (hit.path.isNotBlank()) Text(hit.path, style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (hit.snippet.isNotBlank()) Text(hit.snippet, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider(Modifier.padding(start = 16.dp), color = colors.outlineVariant)
    }
}

@Composable
private fun KnowledgeEmpty(state: KnowledgeUiState, onReset: () -> Unit, onNewPage: () -> Unit) {
    when {
        state.searching -> EmptyState(ReiIcons.Search, "No matching pages", body = "Try another search or clear your filters.") {
            OutlinedButton(onReset) { Text("Clear filters") }
        }
        state.tab == KnowledgeTab.Trash -> EmptyState(ReiIcons.Trash, "Trash is empty", body = "Pages you move to Trash stay here until they’re restored.")
        state.tab == KnowledgeTab.Favorites -> EmptyState(ReiIcons.Star, "No favorites yet", body = "Favorite a page from its menu to find it here.")
        else -> EmptyState(ReiIcons.Knowledge, "No pages yet", body = "Write the first page, or ask an agent to save what it learns.") {
            OutlinedButton(onNewPage) { Text("New page") }
        }
    }
}

@Composable
private fun KnowledgeFilterSheet(
    state: KnowledgeUiState,
    onTab: (KnowledgeTab) -> Unit,
    onToggleTag: (String) -> Unit,
    onReset: () -> Unit,
    onDismiss: () -> Unit,
) {
    ReiSheet(onDismiss = onDismiss, title = "Filters") {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Show", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KnowledgeTab.entries.forEach { tab -> FilterChip(state.tab == tab, { onTab(tab) }, { Text(tab.label) }) }
            }
            if (state.allTags.isNotEmpty()) {
                Text("Tags", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    state.allTags.forEach { tag -> FilterChip(tag in state.selectedTags, { onToggleTag(tag) }, { Text("#$tag") }) }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onReset, enabled = state.tab != KnowledgeTab.All || state.selectedTags.isNotEmpty()) { Text("Reset filters") }
            }
        }
    }
}

/** "5 min. ago" style age; a clock a little ahead of this device never reads as "In 0 min.". */
internal fun relative(@Suppress("UNUSED_PARAMETER") context: android.content.Context, millis: Long): String {
    val now = System.currentTimeMillis()
    return DateUtils.getRelativeTimeSpanString(minOf(millis, now), now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE).toString()
}
