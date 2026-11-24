package dev.rei.android.feature.knowledge

import androidx.compose.runtime.Immutable
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.KnowledgeHit
import dev.rei.android.data.KnowledgeNode
import dev.rei.android.data.ReiApi
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.data.knowledgePage
import dev.rei.android.data.knowledgeTags
import dev.rei.android.data.knowledgeTrash
import dev.rei.android.data.knowledgeTree
import dev.rei.android.data.restoreKnowledgePage
import dev.rei.android.data.searchKnowledge
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

enum class KnowledgeTab(val label: String) { All("All pages"), Favorites("Favorites"), Trash("Trash") }

/** One visible line of the page list: a node at [depth], open or closed. */
@Immutable
data class KnowledgeRow(val node: KnowledgeNode, val depth: Int, val expanded: Boolean)

@Immutable
data class KnowledgeUiState(
    val searchText: String = "",
    val tab: KnowledgeTab = KnowledgeTab.All,
    val selectedTags: List<String> = emptyList(),
    val allTags: List<String> = emptyList(),
    val tree: List<KnowledgeNode> = emptyList(),
    val trash: List<KnowledgeNode> = emptyList(),
    val hits: List<KnowledgeHit> = emptyList(),
    val expanded: Set<String> = emptySet(),
    /** Tags by page id, filled lazily for the rows that scroll into view (the tree carries none). */
    val tags: Map<String, List<String>> = emptyMap(),
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val loadFailed: Boolean = false,
    val error: String? = null,
) {
    /** Words or tags are set: the list shows search results instead of the tree. */
    val searching get() = searchText.isNotBlank() || selectedTags.isNotEmpty()
    val rows: List<KnowledgeRow> by lazy(LazyThreadSafetyMode.NONE) { knowledgeRows(tab, tree, trash, expanded) }
}

/**
 * The visible page rows. All pages: roots first, children under an open parent, depth first. Favorites: pinned pages as a
 * flat list. Trash: trashed pages as a flat list. A node whose parent isn't in the list counts as a root.
 */
fun knowledgeRows(tab: KnowledgeTab, tree: List<KnowledgeNode>, trash: List<KnowledgeNode>, expanded: Set<String>): List<KnowledgeRow> = when (tab) {
    KnowledgeTab.Trash -> trash.map { KnowledgeRow(it, 0, false) }
    KnowledgeTab.Favorites -> tree.filter { it.pinned }.map { KnowledgeRow(it, 0, false) }
    KnowledgeTab.All -> {
        val ids = tree.mapTo(HashSet()) { it.id }
        val children = tree.filter { it.parentId != null && it.parentId in ids }.groupBy { it.parentId }
        buildList {
            fun walk(node: KnowledgeNode, depth: Int) {
                val open = node.id in expanded && children[node.id].orEmpty().isNotEmpty()
                add(KnowledgeRow(node, depth, open))
                if (open) children[node.id].orEmpty().forEach { walk(it, depth + 1) }
            }
            tree.filter { it.parentId == null || it.parentId !in ids }.forEach { walk(it, 0) }
        }
    }
}

private const val KeyText = "knowledge_text"
private const val KeyTab = "knowledge_tab"
private const val KeyTags = "knowledge_tags"
private const val KeyExpanded = "knowledge_expanded"

/** The page list: tree, favorites, trash, search and tag filter, with quiet refresh after a change elsewhere. */
@OptIn(FlowPreview::class)
class KnowledgeViewModel(
    private val session: SessionRepository,
    private val workspace: WorkspaceRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val initialText = savedStateHandle.get<String>(KeyText).orEmpty()
    private val initialTab = savedStateHandle.get<String>(KeyTab)?.let { name -> KnowledgeTab.entries.firstOrNull { it.name == name } } ?: KnowledgeTab.All
    private val initialTags = savedStateHandle.get<ArrayList<String>>(KeyTags)?.toList().orEmpty()
    private val initialExpanded = savedStateHandle.get<ArrayList<String>>(KeyExpanded)?.toSet().orEmpty()

    private val mutable = MutableStateFlow(
        KnowledgeUiState(
            searchText = initialText,
            tab = initialTab,
            selectedTags = initialTags,
            expanded = initialExpanded,
        ),
    )
    val state: StateFlow<KnowledgeUiState> = mutable.asStateFlow()
    private val text = MutableStateFlow(initialText)
    private val facets = MutableStateFlow(Pair(initialTab, initialTags))
    private var load: Job? = null
    private var api: ReiApi? = null
    private val pending = HashSet<String>()
    private val gate = Semaphore(3)

    init {
        viewModelScope.launch {
            combine(session.api, text.debounce(250).distinctUntilChanged(), facets) { api, text, facets ->
                Triple(api, text, facets)
            }.collectLatest { (api, text, facets) ->
                this@KnowledgeViewModel.api = api
                if (api != null) reload(api, text, facets.first, facets.second, refreshing = false)
            }
        }
        viewModelScope.launch { workspace.pagesChanged.collect { refresh(quiet = true) } }
    }

    fun setText(value: String) {
        savedStateHandle[KeyText] = value
        mutable.update { it.copy(searchText = value) }
        text.value = value
    }

    fun setTab(tab: KnowledgeTab) {
        savedStateHandle[KeyTab] = tab.name
        mutable.update { it.copy(tab = tab) }
        facets.update { it.copy(first = tab) }
    }

    fun toggleTag(tag: String) {
        val next = mutable.value.selectedTags.let { if (tag in it) it - tag else it + tag }
        savedStateHandle[KeyTags] = ArrayList(next)
        mutable.update { it.copy(selectedTags = next) }
        facets.update { it.copy(second = next) }
    }

    fun clearFilters() {
        savedStateHandle[KeyTab] = KnowledgeTab.All.name
        savedStateHandle[KeyTags] = arrayListOf<String>()
        mutable.update { it.copy(tab = KnowledgeTab.All, selectedTags = emptyList()) }
        facets.value = KnowledgeTab.All to emptyList()
        setText("")
    }

    fun toggleExpanded(id: String) {
        val next = mutable.value.expanded.let { if (id in it) it - id else it + id }
        savedStateHandle[KeyExpanded] = ArrayList(next)
        mutable.update { it.copy(expanded = next) }
    }

    fun refresh(quiet: Boolean = false) {
        val api = api ?: return
        val (tab, tags) = facets.value
        load?.cancel()
        load = viewModelScope.launch { reload(api, text.value, tab, tags, refreshing = !quiet) }
    }

    fun retry() = refresh()

    private suspend fun reload(api: ReiApi, text: String, tab: KnowledgeTab, tags: List<String>, refreshing: Boolean) {
        mutable.update { it.copy(refreshing = refreshing, error = null, loadFailed = false) }
        try {
            val searching = text.isNotBlank() || tags.isNotEmpty()
            when {
                searching -> {
                    val hits = api.searchKnowledge(text.trim(), tags)
                    mutable.update { it.copy(hits = hits, loaded = true, refreshing = false) }
                }
                tab == KnowledgeTab.Trash -> {
                    val trash = api.knowledgeTrash()
                    mutable.update { it.copy(trash = trash, loaded = true, refreshing = false) }
                }
                else -> {
                    val tree = api.knowledgeTree()
                    mutable.update { it.copy(tree = tree, loaded = true, refreshing = false) }
                }
            }
            if (mutable.value.allTags.isEmpty() || refreshing) {
                suspendRunCatching { api.knowledgeTags() }.onSuccess { all -> mutable.update { it.copy(allTags = all) } }
            }
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            mutable.update {
                it.copy(
                    loaded = true,
                    refreshing = false,
                    loadFailed = it.tree.isEmpty() && it.trash.isEmpty() && it.hits.isEmpty(),
                    error = failure.localizedMessage ?: "Could not load pages.",
                )
            }
        }
    }

    /** Fetches a row's tags the first time it is shown; a few at a time so scrolling stays light. */
    fun ensureTags(id: String) {
        val api = api ?: return
        if (id in mutable.value.tags || !pending.add(id)) return
        viewModelScope.launch {
            try {
                val tags = gate.withPermit { api.knowledgePage(id).tags }
                mutable.update { it.copy(tags = it.tags + (id to tags)) }
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // No tags shown for this row; scrolling back retries.
            } finally {
                pending.remove(id)
            }
        }
    }

    fun restore(node: KnowledgeNode) {
        val api = api ?: return
        viewModelScope.launch {
            try {
                api.restoreKnowledgePage(node.id)
                mutable.update { it.copy(trash = it.trash.filterNot { page -> page.id == node.id }) }
                workspace.notifyPagesChanged()
                workspace.showNotice("Restored “${node.title}”")
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                workspace.showNotice(failure.localizedMessage ?: "Could not restore the page.")
            }
        }
    }

    fun dismissError() = mutable.update { it.copy(error = null) }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                KnowledgeViewModel(
                    session = container.sessionRepository,
                    workspace = container.workspaceRepository,
                    savedStateHandle = createSavedStateHandle(),
                )
            }
        }
    }
}
