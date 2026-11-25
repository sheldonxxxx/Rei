package dev.rei.android.data

import android.content.SharedPreferences
import androidx.core.content.edit
import dev.rei.android.MessageTarget
import dev.rei.android.NotificationTarget
import dev.rei.android.chatDraftKey
import dev.rei.android.di.AppDispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Live catalog of agents, sessions, approvals, browser takeovers, and the currently open chat id. */
data class ChatCatalogState(
    val sessions: List<Session> = emptyList(),
    val agents: List<ChatAgent> = emptyList(),
    val selectedAgentId: String? = null,
    val nextCursor: String? = null,
    val historyLoaded: Boolean = false,
    val sessionId: String? = null,
    val waitingApprovals: List<ReiApproval> = emptyList(),
    val takeoverSessionIds: Set<String> = emptySet(),
    val loading: Boolean = false,
    val error: String? = null,
)

/**
 * Owns the signed-in agent and chat catalog. Catalog paging/refresh uses a dedicated [loadJob] so user actions
 * (`newChat`, `pinChat`, `renameChat`, `deleteChat`) never drop behind an in-flight list load.
 */
class ChatCatalogRepository(
    private val scope: CoroutineScope,
    private val session: SessionRepository,
    private val preferences: SharedPreferences,
    private val dispatchers: AppDispatchers = AppDispatchers(),
) {
    private val mutableState = MutableStateFlow(ChatCatalogState())
    val state: StateFlow<ChatCatalogState> = mutableState.asStateFlow()

    private val current get() = mutableState.value
    private var loadJob: Job? = null
    private var hasOpenedInitialChat = false
    private var hadApi = false

    init {
        scope.launch(dispatchers.main) {
            session.api.collect { api ->
                loadJob?.cancel()
                hasOpenedInitialChat = false
                if (api == null) {
                    if (hadApi) {
                        // Drafts, attachments and last-chat pointers belong to the signed-in account, so they go with it.
                        preferences.edit { clear() }
                    }
                    hadApi = false
                    mutableState.value = ChatCatalogState()
                } else {
                    hadApi = true
                    mutableState.value = ChatCatalogState()
                }
            }
        }
        scope.launch(dispatchers.main) {
            session.globalEvents.collect { event ->
                val api = session.currentApi ?: return@collect
                applyGlobalEvent(api, event)
            }
        }
    }

    private fun applyGlobalEvent(api: ReiApi, event: GlobalEvent) {
        when (event) {
            is GlobalEvent.Changed -> Unit
            is GlobalEvent.Snapshot -> {
                val selected = (current.selectedAgentId ?: preferences.getString(agentKey(api), null))
                    ?.takeIf { id -> event.agents.any { it.id == id } } ?: event.defaultAgentId
                mutableState.update {
                    it.copy(
                        sessions = event.sessions,
                        agents = event.agents,
                        selectedAgentId = selected,
                        nextCursor = null,
                        historyLoaded = true,
                        waitingApprovals = event.approvals,
                        takeoverSessionIds = event.takeoverSessionIds,
                    )
                }
                if (!hasOpenedInitialChat) {
                    val saved = preferences.getString(lastKey(api), null)
                    hasOpenedInitialChat = true
                    val home = event.agents.firstOrNull { it.id == selected }?.homeSessionId ?: event.homeSessionId
                    val initial = current.sessionId ?: saved ?: home
                    if (initial.isNotBlank()) openChat(initial)
                }
            }
            is GlobalEvent.Upserted -> mutableState.update { state ->
                state.copy(sessions = listOf(event.session) + state.sessions.filter { it.id != event.session.id })
            }
            is GlobalEvent.ApprovalUpserted -> mutableState.update { state ->
                val others = state.waitingApprovals.filterNot { it.id == event.approval.id }
                state.copy(waitingApprovals = if (event.approval.status == "pending") others + event.approval else others)
            }
            is GlobalEvent.TakeoverUpserted -> mutableState.update { state ->
                state.copy(
                    takeoverSessionIds = if (event.open) state.takeoverSessionIds + event.sessionId
                    else state.takeoverSessionIds - event.sessionId,
                )
            }
            is GlobalEvent.Removed -> {
                mutableState.update { state -> state.copy(sessions = state.sessions.filter { it.id != event.id }) }
                if (current.sessionId == event.id) closeChat()
            }
            is GlobalEvent.AgentUpdated -> mutableState.update { state ->
                val others = state.agents.filterNot { it.id == event.agent.id }
                state.copy(agents = (others + event.agent).sortedBy { it.name.lowercase() })
            }
            is GlobalEvent.AgentRemoved -> {
                val available = current.agents.filterNot { it.id == event.id }
                mutableState.update { it.copy(agents = available) }
                if (current.selectedAgentId == event.id) {
                    available.firstOrNull()?.let(::selectAgent)
                        ?: mutableState.update { it.copy(selectedAgentId = null, nextCursor = null) }
                }
            }
        }
    }

    fun loadChats() {
        val api = session.currentApi ?: return
        val cursor = if (current.historyLoaded) current.nextCursor ?: return else null
        if (loadJob?.isActive == true) return
        val agent = current.selectedAgentId
        loadJob = scope.launch(dispatchers.main) {
            mutableState.update { it.copy(loading = true, error = null) }
            try {
                val page = api.sessions(cursor, agent)
                if (current.selectedAgentId != agent || session.currentApi !== api) return@launch
                mutableState.update {
                    it.copy(
                        sessions = (it.sessions + page.sessions).distinctBy(Session::id),
                        nextCursor = page.nextCursor,
                        historyLoaded = true,
                    )
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                session.reportFailure(failure)
            } finally {
                mutableState.update { it.copy(loading = false) }
            }
        }
    }

    fun refreshChats() {
        val api = session.currentApi ?: return
        val agent = current.selectedAgentId
        loadJob?.cancel()
        loadJob = scope.launch(dispatchers.main) {
            mutableState.update { it.copy(loading = true, error = null) }
            try {
                val page = api.sessions(agentId = agent)
                if (current.selectedAgentId != agent || session.currentApi !== api) return@launch
                mutableState.update {
                    val unaffected = it.sessions.filter { session ->
                        session.origin == "home" || (agent != null && session.agentId != agent)
                    }
                    it.copy(
                        sessions = (unaffected + page.sessions).distinctBy(Session::id),
                        nextCursor = page.nextCursor,
                        historyLoaded = true,
                    )
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                session.reportFailure(failure)
            } finally {
                mutableState.update { it.copy(loading = false) }
            }
        }
    }

    fun newChat() = launchMutation { api ->
        val agentId = current.selectedAgentId ?: current.agents.firstOrNull()?.id
        val created = api.createSession(agentId)
        mutableState.update { it.copy(sessions = (listOf(created) + it.sessions).distinctBy(Session::id)) }
        openChat(created.id)
    }

    fun selectAgent(agent: ChatAgent) {
        val api = session.currentApi ?: return
        preferences.edit { putString(agentKey(api), agent.id) }
        mutableState.update { it.copy(selectedAgentId = agent.id, nextCursor = null) }
        agent.homeSessionId.takeIf(String::isNotBlank)?.let(::openChat)
    }

    fun openHistoryHit(hit: HistoryHit) {
        openChat(hit.sessionId)
        session.setMessageTarget(MessageTarget(hit.sessionId, hit.messageId))
    }

    fun openNotification(target: NotificationTarget) {
        if (target.sessionId.isBlank()) return
        hasOpenedInitialChat = true
        openChat(target.sessionId)
        session.setMessageTarget(target.messageId?.let { MessageTarget(target.sessionId, it) })
    }

    fun renameChat(id: String, title: String) = launchMutation { api ->
        upsertSession(api.updateChat(id, title = title.trim()))
    }

    fun pinChat(id: String, pinned: Boolean) = launchMutation { api ->
        upsertSession(api.updateChat(id, pinned = pinned))
    }

    fun deleteChat(id: String, deleteForks: Boolean) = launchMutation { api ->
        api.deleteChat(id, deleteForks)
        if (current.sessionId == id) closeChat()
        val key = chatDraftKey(api.serverUrl, id)
        preferences.edit {
            remove(key).remove("$key:attachments").remove("$key:request").remove("$key:request:text")
                .remove("$key:request:attachments")
        }
        mutableState.update { state -> state.copy(sessions = state.sessions.filterNot { it.id == id }) }
    }

    fun openChat(id: String) {
        val api = session.currentApi ?: return
        if (current.sessionId == id) return
        preferences.edit { putString(lastKey(api), id) }
        current.sessions.firstOrNull { it.id == id }?.agentId?.let { rememberAgent(api, it) }
        mutableState.update { it.copy(sessionId = id, error = null) }
    }

    fun closeChat() {
        val api = session.currentApi ?: return
        preferences.edit { remove(lastKey(api)) }
        mutableState.update { it.copy(sessionId = null, error = null) }
    }

    private fun upsertSession(session: Session) {
        mutableState.update { state ->
            state.copy(sessions = (listOf(session) + state.sessions).distinctBy(Session::id))
        }
    }

    private fun launchMutation(block: suspend (ReiApi) -> Unit) {
        val api = session.currentApi ?: return
        scope.launch(dispatchers.main) {
            try {
                block(api)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                session.reportFailure(failure)
            }
        }
    }

    private fun rememberAgent(api: ReiApi, id: String) {
        if (current.selectedAgentId == id) return
        preferences.edit { putString(agentKey(api), id) }
        mutableState.update { it.copy(selectedAgentId = id, nextCursor = null) }
    }

    private fun agentKey(api: ReiApi) = "agent:${api.serverUrl}"
    private fun lastKey(api: ReiApi) = "last:${api.serverUrl}"
}
