package dev.rei.android.shell

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.ReiUiState
import dev.rei.android.ReiViewModel
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.HistoryHit
import dev.rei.android.data.searchHistory
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

/**
 * The shell's state: the drawer's agents, chats and attention counts, the chat filter, history search and the theme
 * choice. It reads the signed-in session through [source] (the global stream still lives in `ReiViewModel` until the chat
 * phase moves chat state out) and keeps everything that belongs to navigation here, so destinations never reach into it.
 */
class ShellViewModel(application: Application, private val source: ReiViewModel) : AndroidViewModel(application) {
    private val themeStore = ThemePreferenceStore.get(application)
    private val showTriggers = MutableStateFlow(false)
    private val searchState = MutableStateFlow(SearchUiState())
    private var searchJob: Job? = null

    val themePreference: StateFlow<ThemePreference> = themeStore.preference
    val search: StateFlow<SearchUiState> = searchState.asStateFlow()

    /** Background Activity's data: here so the drawer badge counts everything in "Needs you" before the page is opened. */
    val activity = ActivityStore(viewModelScope, source)

    val drawer: StateFlow<DrawerUiState> = combine(source.state, showTriggers, activity.state) { state, triggers, work ->
        state.toDrawer(triggers, work.feed.needsCount)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, DrawerUiState())

    fun setThemePreference(value: ThemePreference) = themeStore.set(value)

    fun setShowTriggers(show: Boolean) { showTriggers.value = show }

    // Chats: the drawer acts on the signed-in catalog through the session owner.
    fun newChat() = source.newChat()
    fun openChat(id: String) = source.openChat(id)
    fun selectAgent(agent: ChatAgent) = source.selectAgent(agent)
    fun refreshChats() = source.refreshChats()
    fun loadMoreChats() = source.loadChats()
    fun renameChat(id: String, title: String) = source.renameChat(id, title)
    fun pinChat(id: String, pinned: Boolean) = source.pinChat(id, pinned)
    fun deleteChat(id: String) = source.deleteChat(id, deleteForks = false)

    // History search.
    fun setQuery(query: String) {
        searchState.update { it.copy(query = query, hits = if (query.isBlank()) emptyList() else it.hits) }
        searchJob?.cancel()
        if (query.isBlank()) { searchState.update { it.copy(status = null) }; return }
        val state = source.state.value
        val api = state.api ?: return
        searchJob = viewModelScope.launch {
            searchState.update { it.copy(status = "Searching…") }
            delay(250)
            try {
                val hits = api.searchHistory(query.trim(), state.selectedAgentId)
                searchState.update { it.copy(hits = hits, status = if (hits.isEmpty()) "No matching messages" else null) }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                searchState.update { it.copy(hits = emptyList(), status = failure.localizedMessage ?: "Search failed") }
            }
        }
    }

    fun clearSearch() { searchJob?.cancel(); searchState.value = SearchUiState() }

    fun openHit(hit: HistoryHit) = source.openHistoryHit(hit)

    private fun ReiUiState.toDrawer(triggers: Boolean, needsCount: Int): DrawerUiState {
        val attention = waitingApprovals.map { it.sessionId }.toSet() + takeoverSessionIds
        return DrawerUiState(
            agents = agents,
            selectedAgentId = selectedAgentId,
            openSessionId = sessionId,
            groups = groupChats(sessions, agents, selectedAgentId, sessionId, triggers),
            attentionCount = needsCount,
            attentionSessionIds = attention,
            loaded = historyLoaded,
            hasMore = nextCursor != null,
            loading = working,
            showTriggers = triggers,
            serverUrl = serverUrl,
        )
    }

    companion object {
        /** One shell view model per activity, over that activity's [ReiViewModel]. */
        fun factory(source: ReiViewModel): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                ShellViewModel(this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as Application, source)
            }
        }
    }
}
