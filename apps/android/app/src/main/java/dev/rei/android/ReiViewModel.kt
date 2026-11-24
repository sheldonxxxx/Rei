package dev.rei.android

import android.app.Activity
import android.app.Application
import android.content.Context
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.AuthState
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.CredentialStore
import dev.rei.android.data.GlobalEvent
import dev.rei.android.data.HistoryHit
import dev.rei.android.data.Message
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.Session
import dev.rei.android.data.SessionDetail
import dev.rei.android.data.SessionEvent
import dev.rei.android.data.deleteChat
import dev.rei.android.data.updateChat
import dev.rei.android.update.UpdateManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.io.IOException
import java.util.UUID

data class ReiUiState(
    val serverUrl: String = "",
    val auth: AuthState? = null,
    val api: ReiApi? = null,
    val working: Boolean = false,
    val error: String? = null,
    /** The server's error code for [error] (for example `bad_totp`), so a screen can show it under the right field. */
    val errorCode: String? = null,
    val upgradeRequired: Boolean = false,
    val sessions: List<Session> = emptyList(),
    val agents: List<ChatAgent> = emptyList(),
    val selectedAgentId: String? = null,
    val nextCursor: String? = null,
    val historyLoaded: Boolean = false,
    /** The chat open in the chat destination. Its conversation lives in `ChatViewModel`. */
    val sessionId: String? = null,
    /** Approvals waiting in every session, oldest first. The shell reads them for its badge and attention dots. */
    val waitingApprovals: List<ReiApproval> = emptyList(),
    /** Sessions with a browser takeover waiting for the user. */
    val takeoverSessionIds: Set<String> = emptySet(),
    /** True until the saved sign-in has been checked, so the splash screen can wait and the connect screen never flashes. */
    val restoring: Boolean = false,
)

/** A message to scroll to (and briefly highlight) once its chat is open. */
data class MessageTarget(val sessionId: String, val messageId: String)

/** SharedPreferences key prefix (file `chat_state`) for a chat's draft: `key`, `key:attachments`, `key:request`. */
internal fun chatDraftKey(serverUrl: String, sessionId: String) = "draft:$serverUrl:$sessionId"

class ReiViewModel(application: Application) : AndroidViewModel(application) {
    private val credentials = CredentialStore(application)
    private val local = application.getSharedPreferences("chat_state", Context.MODE_PRIVATE)
    private val mutableState = MutableStateFlow(ReiUiState(restoring = true))
    val state = mutableState.asStateFlow()

    private val changeNotices = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /**
     * Payload-free change notices from the global stream (`background.changed`, `triggers.changed`, `memory.changed`, and
     * `snapshot` after every (re)connect): screens that show those things fetch again.
     */
    val changes: SharedFlow<String> = changeNotices.asSharedFlow()

    private val foregroundState = MutableStateFlow(false)
    private val messageTargetState = MutableStateFlow<MessageTarget?>(null)

    /** True while the app is on screen. Streams that only matter on screen (the open chat, presence) follow it. */
    val inForeground: StateFlow<Boolean> = foregroundState.asStateFlow()

    /** A message the chat should open at: a notification or a history hit. The chat consumes it once it has scrolled there. */
    val messageTarget: StateFlow<MessageTarget?> = messageTargetState.asStateFlow()
    private var globalJob: Job? = null
    private var operation: Job? = null
    private var hasOpenedInitialChat = false
    private val current get() = mutableState.value

    init {
        runOperation {
            try {
                val saved = withContext(Dispatchers.IO) { credentials.load() } ?: return@runOperation
                mutableState.update { it.copy(serverUrl = saved.serverUrl) }
                probe(ReiApi(saved.serverUrl, saved.token))
            } finally {
                mutableState.update { it.copy(restoring = false) }
            }
        }
    }

    fun connect(serverUrl: String) = runOperation {
        val api = ReiApi(serverUrl)
        val saved = withContext(Dispatchers.IO) { credentials.load() }
        if (saved != null && saved.serverUrl != api.serverUrl) {
            withContext(Dispatchers.IO) { credentials.clear() }
        }
        val token = saved?.takeIf { it.serverUrl == api.serverUrl }?.token
        mutableState.update { it.copy(serverUrl = api.serverUrl, auth = null) }
        probe(if (token == null) api else ReiApi(api.serverUrl, token))
    }

    private suspend fun probe(api: ReiApi) {
        api.health()
        val auth = api.authState()
        if (auth.signedIn) {
            enter(api)
        } else {
            withContext(Dispatchers.IO) { credentials.save(api.serverUrl, null) }
            mutableState.update { it.copy(auth = auth, serverUrl = api.serverUrl) }
        }
    }

    fun signIn(password: String, code: String, deviceLabel: String) = runOperation {
        val auth = current.auth ?: return@runOperation
        val api = ReiApi(current.serverUrl)
        val token = if (auth.setupRequired) {
            api.setup(code.trim(), password, deviceLabel.trim())
        } else {
            api.login(password, code.trim().ifEmpty { null }, deviceLabel.trim())
        }
        saveSignedInDevice(api, token)
    }

    fun signInWithPasskey(activity: Activity, deviceLabel: String) = runOperation {
        val api = ReiApi(current.serverUrl)
        if (current.auth?.passkeys != true) return@runOperation
        val token = authenticateWithPasskey(activity, api, deviceLabel.trim()) ?: return@runOperation
        saveSignedInDevice(api, token)
    }

    private suspend fun saveSignedInDevice(api: ReiApi, token: String) {
        withContext(Dispatchers.IO) { credentials.save(api.serverUrl, token) }
        enter(ReiApi(api.serverUrl, token))
    }

    private fun enter(api: ReiApi) {
        hasOpenedInitialChat = false
        mutableState.update { ReiUiState(serverUrl = api.serverUrl, api = api, working = it.working) }
        observeGlobal(api)
        ReiFirebase.sync(getApplication<Application>())
    }

    fun signOut() = runOperation {
        val api = current.api ?: return@runOperation
        val revoked = revoke(api)
        reset(api.serverUrl, if (!revoked) "Signed out here. Revoke this device in Rei when the server is reachable." else null)
        if (revoked) probe(ReiApi(api.serverUrl))
    }

    fun disconnect() = runOperation {
        val api = current.api
        val revoked = api == null || revoke(api)
        reset(error = if (!revoked) "Disconnected here. Revoke this device in Rei when the server is reachable." else null)
    }

    private suspend fun revoke(api: ReiApi): Boolean = try {
        api.logout()
        true
    } catch (failure: IOException) {
        failure is ReiApiException && failure.status == 401
    }

    private suspend fun reset(serverUrl: String = "", error: String? = null, upgrade: Boolean = false) {
        val caller = currentCoroutineContext()[Job]
        listOf(globalJob).filter { it != caller }.forEach { it?.cancel() }
        messageTargetState.value = null
        withContext(Dispatchers.IO) { credentials.clear() }
        // Drafts, attachments and last-chat pointers belong to the signed-in account, so they go with it.
        local.edit { clear() }
        ReiNotifications.signedOut(getApplication<Application>())
        mutableState.value = ReiUiState(serverUrl = serverUrl, error = error, upgradeRequired = upgrade)
    }

    fun foreground(visible: Boolean) {
        foregroundState.value = visible
        val api = current.api ?: return
        if (visible) {
            ReiFirebase.sync(getApplication<Application>())
            if (globalJob?.isActive != true) observeGlobal(api)
        }
    }

    /** What a chat that failed on the session's behalf cannot handle itself: a signed-out device or an outdated app. */
    fun reportFailure(failure: Exception) {
        viewModelScope.launch { handleFailure(failure) }
    }

    private fun observeGlobal(api: ReiApi) {
        globalJob?.cancel()
        globalJob = viewModelScope.launch {
            try {
                api.globalStream().collect { event ->
                    when (event) {
                        is GlobalEvent.Changed -> changeNotices.tryEmit(event.type)
                        is GlobalEvent.Snapshot -> {
                            changeNotices.tryEmit("snapshot")
                            val selected = (current.selectedAgentId ?: local.getString(agentKey(api), null))
                                ?.takeIf { id -> event.agents.any { it.id == id } } ?: event.defaultAgentId
                            mutableState.update {
                                it.copy(
                                    sessions = event.sessions, agents = event.agents, selectedAgentId = selected,
                                    nextCursor = null, historyLoaded = true,
                                    waitingApprovals = event.approvals, takeoverSessionIds = event.takeoverSessionIds,
                                )
                            }
                            if (!hasOpenedInitialChat) {
                                val saved = local.getString(lastKey(api), null)
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
            } catch (failure: Exception) {
                handleFailure(failure)
            }
        }
    }

    fun loadChats() = runOperation {
        val api = current.api ?: return@runOperation
        val cursor = if (current.historyLoaded) current.nextCursor ?: return@runOperation else null
        val agent = current.selectedAgentId
        val page = api.sessions(cursor, agent)
        if (current.selectedAgentId != agent || current.api !== api) return@runOperation
        mutableState.update {
            it.copy(
                sessions = (it.sessions + page.sessions).distinctBy(Session::id),
                nextCursor = page.nextCursor,
                historyLoaded = true,
            )
        }
    }

    fun refreshChats() = runOperation {
        val api = current.api ?: return@runOperation
        val agent = current.selectedAgentId
        val page = api.sessions(agentId = agent)
        if (current.selectedAgentId != agent || current.api !== api) return@runOperation
        mutableState.update {
            val unaffected = it.sessions.filter { session -> session.origin == "home" || (agent != null && session.agentId != agent) }
            it.copy(sessions = (unaffected + page.sessions).distinctBy(Session::id), nextCursor = page.nextCursor, historyLoaded = true)
        }
    }

    fun newChat() = runOperation {
        val api = current.api ?: return@runOperation
        val session = api.createSession(current.selectedAgentId)
        mutableState.update { it.copy(sessions = (listOf(session) + it.sessions).distinctBy(Session::id)) }
        openChat(session.id)
    }

    fun selectAgent(agent: ChatAgent) {
        val api = current.api ?: return
        local.edit { putString(agentKey(api), agent.id) }
        mutableState.update { it.copy(selectedAgentId = agent.id, nextCursor = null) }
        agent.homeSessionId.takeIf(String::isNotBlank)?.let(::openChat)
    }

    fun openHistoryHit(hit: HistoryHit) {
        openChat(hit.sessionId)
        messageTargetState.value = MessageTarget(hit.sessionId, hit.messageId)
    }

    fun renameChat(id: String, title: String) = runOperation {
        val api = current.api ?: return@runOperation
        updateChat(api.updateChat(id, title = title.trim()))
    }

    fun pinChat(id: String, pinned: Boolean) = runOperation {
        val api = current.api ?: return@runOperation
        updateChat(api.updateChat(id, pinned = pinned))
    }

    private fun updateChat(session: Session) {
        mutableState.update { state ->
            state.copy(
                sessions = (listOf(session) + state.sessions).distinctBy(Session::id),
            )
        }
    }

    fun deleteChat(id: String, deleteForks: Boolean) = runOperation {
        val api = current.api ?: return@runOperation
        api.deleteChat(id, deleteForks)
        if (current.sessionId == id) closeChat()
        val key = chatDraftKey(api.serverUrl, id)
        local.edit {
            remove(key).remove("$key:attachments").remove("$key:request").remove("$key:request:text").remove("$key:request:attachments")
        }
        mutableState.update { state -> state.copy(sessions = state.sessions.filterNot { it.id == id }) }
    }

    internal fun openNotification(target: NotificationTarget) {
        if (target.sessionId.isBlank()) return
        hasOpenedInitialChat = true
        openChat(target.sessionId)
        messageTargetState.value = target.messageId?.let { MessageTarget(target.sessionId, it) }
    }

    fun consumeMessageTarget(target: MessageTarget) {
        messageTargetState.update { if (it == target) null else it }
    }

    fun openChat(id: String) {
        val api = current.api ?: return
        if (current.sessionId == id) return
        local.edit { putString(lastKey(api), id) }
        current.sessions.firstOrNull { it.id == id }?.agentId?.let { rememberAgent(api, it) }
        mutableState.update { it.copy(sessionId = id, error = null) }
    }

    fun closeChat() {
        val api = current.api ?: return
        local.edit { remove(lastKey(api)) }
        mutableState.update { it.copy(sessionId = null, error = null) }
    }

    private fun runOperation(block: suspend () -> Unit) {
        if (operation?.isActive == true) return
        operation = viewModelScope.launch {
            mutableState.update { it.copy(working = true, error = null, errorCode = null, upgradeRequired = false) }
            try {
                block()
            } catch (failure: Exception) {
                handleFailure(failure)
            } finally {
                mutableState.update { it.copy(working = false) }
            }
        }
    }

    private suspend fun handleFailure(failure: Exception) {
        if (failure is CancellationException) throw failure
        val message = when (failure) {
            is ReiApiException -> failure.message.orEmpty().ifBlank { "Rei could not complete the request." }
            is IllegalArgumentException, is IllegalStateException -> failure.message ?: "Check the server address."
            is IOException -> "Couldn’t reach Rei. Check your connection and try again."
            else -> "Rei returned a response this app couldn’t read."
        }
        val status = (failure as? ReiApiException)?.status
        // The server no longer accepts this app: look for a newer build right away and offer it where the person is.
        if (status == 426) UpdateManager.get(getApplication<Application>()).onClientOutdated()
        if (status == 401 && current.api != null) {
            val url = current.serverUrl
            reset(url, "This device is signed out. Connect and sign in again.")
        } else if (status == 426 && current.api != null) {
            reset(current.serverUrl, message, upgrade = true)
        } else {
            mutableState.update {
                it.copy(error = message, errorCode = (failure as? ReiApiException)?.code, upgradeRequired = status == 426)
            }
        }
    }

    private fun rememberAgent(api: ReiApi, id: String) {
        if (current.selectedAgentId == id) return
        local.edit { putString(agentKey(api), id) }
        mutableState.update { it.copy(selectedAgentId = id, nextCursor = null) }
    }

    private fun agentKey(api: ReiApi) = "agent:${api.serverUrl}"

    private fun lastKey(api: ReiApi) = "last:${api.serverUrl}"
}
