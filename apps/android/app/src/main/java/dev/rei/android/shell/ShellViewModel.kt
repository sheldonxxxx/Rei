package dev.rei.android.shell

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.ChatCatalogRepository
import dev.rei.android.data.ChatCatalogState
import dev.rei.android.data.HistoryHit
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.SessionState
import dev.rei.android.data.searchHistory
import dev.rei.android.di.AppContainer
import dev.rei.android.feature.activity.ActivityStore
import dev.rei.android.ui.theme.ThemePreference
import dev.rei.android.ui.theme.ThemePreferenceStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What the drawer shows. Built from the signed-in session's live catalog (the global stream). */
data class DrawerUiState(
    val agents: List<ChatAgent> = emptyList(),
    val selectedAgentId: String? = null,
    val openSessionId: String? = null,
    val groups: List<ChatGroup> = emptyList(),
    /** Everything in Background Activity's "Needs you" (approvals, takeovers, failures): the badge. */
    val attentionCount: Int = 0,
    /** Sessions with an approval or takeover waiting. */
    val attentionSessionIds: Set<String> = emptySet(),
    val loaded: Boolean = false,
    val hasMore: Boolean = false,
    val loading: Boolean = false,
    val showTriggers: Boolean = false,
    val serverUrl: String = "",
)

data class SearchUiState(
    val query: String = "",
    val hits: List<HistoryHit> = emptyList(),
    val status: String? = null,
)

private const val SearchQueryKey = "history_search_query"

/**
 * The shell's state: the drawer's agents, chats and attention counts, the chat filter, history search and the theme
 * choice. Reads the signed-in session and catalog from repositories directly, keeping search state in [savedStateHandle]
 * across rotation and process death.
 */
class ShellViewModel(
    private val session: SessionRepository,
    private val catalog: ChatCatalogRepository,
    private val themeStore: ThemePreferenceStore,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val showTriggers = MutableStateFlow(false)
    private val initialQuery = savedStateHandle.get<String>(SearchQueryKey).orEmpty()
    private val searchState = MutableStateFlow(SearchUiState(query = initialQuery))
    private var searchJob: Job? = null

    val themePreference: StateFlow<ThemePreference> = themeStore.preference
    val search: StateFlow<SearchUiState> = searchState.asStateFlow()

    /** Background Activity's data: here so the drawer badge counts everything in "Needs you" before the page is opened. */
    val activity = ActivityStore(viewModelScope, session, catalog)

    val drawer: StateFlow<DrawerUiState> = combine(
        session.state,
        catalog.state,
        showTriggers,
        activity.state,
    ) { sessionState, catalogState, triggers, work ->
        toDrawer(sessionState, catalogState, triggers, work.feed.needsCount)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), DrawerUiState())

    init {
        if (initialQuery.isNotBlank()) {
            setQuery(initialQuery)
        }
    }

    fun setThemePreference(value: ThemePreference) = themeStore.set(value)

    fun setShowTriggers(show: Boolean) { showTriggers.value = show }

    // Chats: the drawer acts on the signed-in catalog through the catalog repository.
    fun newChat() = catalog.newChat()
    fun openChat(id: String) = catalog.openChat(id)
    fun selectAgent(agent: ChatAgent) = catalog.selectAgent(agent)
    fun refreshChats() = catalog.refreshChats()
    fun loadMoreChats() = catalog.loadChats()
    fun renameChat(id: String, title: String) = catalog.renameChat(id, title)
    fun pinChat(id: String, pinned: Boolean) = catalog.pinChat(id, pinned)
    fun deleteChat(id: String) = catalog.deleteChat(id, deleteForks = false)

    // History search.
    fun setQuery(query: String) {
        savedStateHandle[SearchQueryKey] = query
        searchState.update { it.copy(query = query, hits = if (query.isBlank()) emptyList() else it.hits) }
        searchJob?.cancel()
        if (query.isBlank()) { searchState.update { it.copy(status = null) }; return }
        val api = session.currentApi ?: return
        val selectedAgentId = catalog.state.value.selectedAgentId
        searchJob = viewModelScope.launch {
            searchState.update { it.copy(status = "Searching…") }
            delay(250)
            try {
                val hits = api.searchHistory(query.trim(), selectedAgentId)
                searchState.update { it.copy(hits = hits, status = if (hits.isEmpty()) "No matching messages" else null) }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                searchState.update { it.copy(hits = emptyList(), status = failure.localizedMessage ?: "Search failed") }
            }
        }
    }

    fun clearSearch() {
        searchJob?.cancel()
        savedStateHandle[SearchQueryKey] = ""
        searchState.value = SearchUiState()
    }

    fun openHit(hit: HistoryHit) = catalog.openHistoryHit(hit)

    private fun toDrawer(
        sessionState: SessionState,
        catalogState: ChatCatalogState,
        triggers: Boolean,
        needsCount: Int,
    ): DrawerUiState {
        val attention = catalogState.waitingApprovals.map { it.sessionId }.toSet() + catalogState.takeoverSessionIds
        return DrawerUiState(
            agents = catalogState.agents,
            selectedAgentId = catalogState.selectedAgentId,
            openSessionId = catalogState.sessionId,
            groups = groupChats(
                catalogState.sessions,
                catalogState.agents,
                catalogState.selectedAgentId,
                catalogState.sessionId,
                triggers,
            ),
            attentionCount = needsCount,
            attentionSessionIds = attention,
            loaded = catalogState.historyLoaded,
            hasMore = catalogState.nextCursor != null,
            loading = sessionState.working || catalogState.loading,
            showTriggers = triggers,
            serverUrl = sessionState.serverUrl,
        )
    }

    companion object {
        /** One shell view model per activity, over [container]'s repositories and SavedStateHandle. */
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                ShellViewModel(
                    session = container.sessionRepository,
                    catalog = container.chatCatalogRepository,
                    themeStore = container.themePreferenceStore,
                    savedStateHandle = createSavedStateHandle(),
                )
            }
        }
    }
}
