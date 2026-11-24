package dev.rei.android.feature.chat

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.MessageTarget
import dev.rei.android.ReiViewModel
import dev.rei.android.chatDraftKey
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.ChatProfile
import dev.rei.android.data.ContextUsage
import dev.rei.android.data.Message
import dev.rei.android.data.ModelCatalog
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.RunTrace
import dev.rei.android.data.Session
import dev.rei.android.data.SessionDetail
import dev.rei.android.data.SessionEvent
import dev.rei.android.data.SkillOption
import dev.rei.android.data.continueRun
import dev.rei.android.data.contextUsage
import dev.rei.android.data.models
import dev.rei.android.data.sessionSkills
import dev.rei.android.data.switchVersion
import dev.rei.android.data.trace
import dev.rei.android.data.updateAgentSettings
import dev.rei.android.data.updateSessionProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.io.IOException
import java.util.UUID

/** A message that has been sent, or is being sent, and that the transcript does not show yet. */
data class PendingSend(
    val requestId: String,
    val text: String,
    val attachments: List<AttachmentRef> = emptyList(),
    val skills: List<SkillOption> = emptyList(),
    /** The send did not reach Rei: shown under the message with Retry. */
    val failed: Boolean = false,
    val error: String? = null,
)

data class ChatUiState(
    val sessionId: String? = null,
    val session: Session? = null,
    val agent: ChatAgent? = null,
    /** The live view; null until the stream has delivered it. */
    val detail: SessionDetail? = null,
    val older: List<Message> = emptyList(),
    val olderCursor: String? = null,
    val olderLoaded: Boolean = false,
    val loadingOlder: Boolean = false,
    val runs: List<RunTrace> = emptyList(),
    val traceLoaded: Boolean = false,
    val traceOlder: String? = null,
    val draft: String = "",
    /** Changes when the draft is replaced from outside the composer (see `ComposerState.draftEpoch`). */
    val draftEpoch: Int = 0,
    val attachments: List<AttachmentRef> = emptyList(),
    val selectedSkills: List<SkillOption> = emptyList(),
    val skills: List<SkillOption> = emptyList(),
    val skillsLoaded: Boolean = false,
    val uploading: Boolean = false,
    val pending: PendingSend? = null,
    val sending: Boolean = false,
    val stopping: Boolean = false,
    /** The stream dropped and is being re-established. */
    val reconnecting: Boolean = false,
    val streamError: String? = null,
    /** A one-off message for a snackbar (something an action could not do). */
    val notice: String? = null,
    val showDetails: Boolean = false,
    val models: ModelCatalog? = null,
    val usage: ContextUsage? = null,
    /** The message to scroll to and highlight, once, then cleared by [ChatViewModel.consumeFocus]. */
    val focus: String? = null,
    /** The level being saved: shown instead of the session's own until Rei answers. */
    val profileChoice: ChatProfile? = null,
    val savingProfile: Boolean = false,
    /** Why the last change of level failed, for the permissions sheet. */
    val profileError: String? = null,
) {
    /** This chat's permission level. It follows the stream, so a change made on the web shows up here. */
    val profile: ChatProfile get() = profileChoice ?: (detail?.session ?: session)?.profile ?: ChatProfile.Standard

    /** Older messages first, then the live view. */
    val messages: List<Message> by lazy(LazyThreadSafetyMode.NONE) {
        (older + detail?.messages.orEmpty()).distinctBy(Message::id).filterNot(Message::internal)
    }
    val olderAvailable: Boolean get() = (if (olderLoaded) olderCursor else detail?.before) != null
    val busy: Boolean get() = detail?.busy == true
    val ready: Boolean get() = detail != null
    val title: String get() = (detail?.session ?: session)?.title.orEmpty()

    /** An approval is waiting in this chat: the composer says so and Send waits. */
    val waitingForAnswer: Boolean get() = messages.any { it.approval?.status == "pending" }
}

/**
 * The open chat: its stream, drafts, attachments, sending and stopping, retry/edit/fork, versions, older history, read
 * markers and presence. The shell keeps only which chat is open (`ReiViewModel.state.sessionId`); this follows it.
 */
class ChatViewModel(application: Application, private val source: ReiViewModel) : AndroidViewModel(application) {
    private val local = application.getSharedPreferences("chat_state", Context.MODE_PRIVATE)
    private val details = ShowDetailsStore.get(application)
    private val mutableState = MutableStateFlow(ChatUiState(showDetails = details.enabled.value))
    val state: StateFlow<ChatUiState> = mutableState.asStateFlow()

    private val visible = MutableStateFlow(false)
    private val retryTick = MutableStateFlow(0)
    private val atBottom = MutableStateFlow(true)
    private var lastRead: String? = null
    private var resolving = false
    private val current get() = mutableState.value

    /**
     * What is typed right now. It is deliberately not in [ChatUiState]: a keystroke must not republish the whole chat (the
     * transcript would recompose per letter and the keyboard would lag). The composer owns the live text; this copy is for
     * Send and for the saved draft, and [ChatUiState.draft] only changes when the draft is replaced from outside.
     */
    private var typed = ""

    private data class Subject(val api: ReiApi?, val id: String?)

    init {
        viewModelScope.launch { details.enabled.collect { value -> mutableState.update { it.copy(showDetails = value) } } }
        viewModelScope.launch {
            // The catalog is the fallback for what the stream has not delivered yet: title, pin, the agent.
            source.state.collect { shell ->
                mutableState.update { chat ->
                    val session = shell.sessions.firstOrNull { it.id == chat.sessionId }
                    val agentId = (chat.detail?.session ?: session)?.agentId
                    chat.copy(session = session ?: chat.session, agent = shell.agents.firstOrNull { it.id == agentId } ?: chat.agent)
                }
            }
        }
        viewModelScope.launch {
            val subjects = source.state.map { Subject(it.api, it.sessionId) }.distinctUntilChanged()
            var opened: Subject? = null
            combine(subjects, source.inForeground, visible, retryTick) { subject, foreground, shown, tick ->
                Run(subject, foreground && shown, tick)
            }.distinctUntilChanged().collectLatest { (subject, active) ->
                if (subject != opened) {
                    open(subject)
                    opened = subject
                }
                val api = subject.api
                val id = subject.id
                if (api == null || id == null || !active) {
                    if (api != null && id != null) reportPresence(api, false)
                    return@collectLatest
                }
                try {
                    run(api, id)
                } catch (failure: CancellationException) {
                    throw failure
                } catch (failure: Exception) {
                    if (failure is ReiApiException && failure.status == 404) {
                        source.closeChat()
                        mutableState.update { it.copy(notice = "This chat is no longer available.") }
                    } else if (failure is ReiApiException && failure.status in setOf(401, 426)) {
                        source.reportFailure(failure)
                    } else {
                        mutableState.update { it.copy(streamError = reason(failure), reconnecting = false) }
                    }
                }
            }
        }
    }

    private data class Run(val subject: Subject, val active: Boolean, val tick: Int)


    /** The chat becomes the one on screen (or not). Streams and presence follow it. */
    fun setVisible(shown: Boolean) { visible.value = shown }

    fun retryStream() { retryTick.value += 1 }

    /** The end of the transcript is on screen: the read marker may move. */
    fun setAtBottom(value: Boolean) {
        atBottom.value = value
        if (value) markLatestRead()
    }

    private fun open(subject: Subject) {
        lastRead = null
        val api = subject.api
        val id = subject.id
        val shell = source.state.value
        val session = shell.sessions.firstOrNull { it.id == id }
        val fresh = ChatUiState(
            sessionId = id,
            session = session,
            agent = shell.agents.firstOrNull { it.id == session?.agentId },
            showDetails = details.enabled.value,
        )
        if (api == null || id == null) {
            mutableState.value = fresh
            return
        }
        val key = chatDraftKey(api.serverUrl, id)
        val request = local.getString("$key:request", null)
        typed = local.getString(key, "").orEmpty()
        mutableState.value = fresh.copy(
            draft = typed,
            draftEpoch = current.draftEpoch + 1,
            attachments = loadAttachments(key),
            pending = request?.let {
                PendingSend(
                    it, local.getString("$key:request:text", "").orEmpty(), loadAttachments("$key:request"),
                    failed = true, error = "Not sent. Retry to check whether Rei received it.",
                )
            },
        )
        viewModelScope.launch {
            try {
                val catalog = api.models()
                mutableState.update { if (it.sessionId == id) it.copy(models = catalog) else it }
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // The model chip falls back to the agent's own value.
            }
        }
    }

    /** One live session: the stream, presence, the trace and the context meter, until cancelled. */
    @OptIn(FlowPreview::class)
    private suspend fun run(api: ReiApi, id: String) = coroutineScope {
        mutableState.update { it.copy(streamError = null) }
        launch {
            while (true) {
                reportPresence(api, true)
                delay(30_000)
            }
        }
        launch {
            mutableState.map { chat -> chat.detail?.let { d -> d.messages.joinToString("|") { "${it.id}:${it.status}" } + "#${d.busy}" } }
                .distinctUntilChanged().debounce(250).collect { key ->
                    if (key == null) return@collect
                    refreshTrace(api, id)
                    refreshUsage(api, id)
                }
        }
        launch {
            // While a run is going, the meter follows it.
            mutableState.map { it.busy }.distinctUntilChanged().collectLatest { busy ->
                while (busy) {
                    delay(3_000)
                    refreshUsage(api, id)
                }
            }
        }
        launch {
            source.messageTarget.collect { resolveTarget(api, id) }
        }
        api.stream(id, connection = { up -> mutableState.update { if (up == it.reconnecting) it.copy(reconnecting = !up) else it } })
            .collect { event ->
                if (current.sessionId != id) return@collect
                when (event) {
                    SessionEvent.Removed -> source.closeChat()
                    is SessionEvent.Updated -> {
                        val detail = event.detail
                        mutableState.update { it.copy(detail = detail, session = detail.session, streamError = null, reconnecting = false) }
                        reconcile(api, id, detail)
                        markLatestRead()
                        resolveTarget(api, id)
                    }
                }
            }
    }

    private suspend fun refreshTrace(api: ReiApi, id: String) {
        try {
            val page = api.trace(id)
            mutableState.update { chat ->
                if (chat.sessionId != id) return@update chat
                val newest = page.runs.map { it.runId }.toSet()
                val keptOlder = chat.runs.filter { it.runId !in newest }
                chat.copy(
                    runs = (keptOlder + page.runs).distinctBy { it.runId },
                    traceLoaded = true,
                    traceOlder = if (chat.traceOlder != null && chat.runs.size > page.runs.size) chat.traceOlder else page.next,
                )
            }
        } catch (failure: CancellationException) {
            throw failure
        } catch (_: Exception) {
            mutableState.update { it.copy(traceLoaded = true) }
        }
    }

    fun loadOlderActivity() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        val before = current.traceOlder ?: return
        viewModelScope.launch {
            try {
                val page = api.trace(id, before)
                mutableState.update { chat ->
                    if (chat.sessionId != id) chat else chat.copy(runs = (page.runs + chat.runs).distinctBy { it.runId }, traceOlder = page.next)
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    private suspend fun refreshUsage(api: ReiApi, id: String) {
        try {
            val usage = api.contextUsage(id)
            mutableState.update { if (it.sessionId == id) it.copy(usage = usage) else it }
        } catch (failure: CancellationException) {
            throw failure
        } catch (_: Exception) {
            // The meter is optional.
        }
    }

    private suspend fun reportPresence(api: ReiApi, shown: Boolean) {
        try {
            api.presence(shown)
        } catch (failure: IOException) {
            if (failure is ReiApiException && failure.status == 401) source.reportFailure(failure)
        }
    }

    private fun markLatestRead() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        if (!atBottom.value) return
        val latest = current.detail?.messages?.lastOrNull { it.role == "assistant" && it.createdAt > 0 } ?: return
        if (latest.id == lastRead) return
        lastRead = latest.id
        viewModelScope.launch {
            try {
                api.markRead(id, latest.id, latest.createdAt)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: IOException) {
                lastRead = null
                if (failure is ReiApiException && failure.status == 401) source.reportFailure(failure)
            }
        }
    }

    // ---- opening at a message ----------------------------------------------------------------------------------

    private suspend fun resolveTarget(api: ReiApi, id: String) {
        val target = source.messageTarget.value?.takeIf { it.sessionId == id } ?: return
        if (resolving || current.detail == null) return
        resolving = true
        try {
            var cursor = if (current.olderLoaded) current.olderCursor else current.detail?.before
            while (current.sessionId == id && source.messageTarget.value == target) {
                if (current.messages.any { it.id == target.messageId }) {
                    mutableState.update { it.copy(focus = target.messageId) }
                    break
                }
                val before = cursor ?: break
                val page = api.transcript(id, before)
                if (current.sessionId != id) return
                cursor = page.before?.takeUnless { it == before }
                mutableState.update {
                    it.copy(older = (page.items + it.older).distinctBy(Message::id), olderCursor = cursor, olderLoaded = true)
                }
            }
        } catch (failure: CancellationException) {
            throw failure
        } catch (_: IOException) {
            // The transcript is still readable if the target could not be found.
        } finally {
            resolving = false
        }
        source.consumeMessageTarget(target)
    }

    /** Scrolls the transcript to [messageId], as opening a chat from a notification does. */
    fun focusMessage(messageId: String) {
        mutableState.update { it.copy(focus = messageId) }
    }

    fun consumeFocus(messageId: String) {
        mutableState.update { if (it.focus == messageId) it.copy(focus = null) else it }
    }

    fun loadOlder() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        if (current.loadingOlder) return
        val cursor = (if (current.olderLoaded) current.olderCursor else current.detail?.before) ?: return
        mutableState.update { it.copy(loadingOlder = true) }
        viewModelScope.launch {
            try {
                val page = api.transcript(id, cursor)
                mutableState.update {
                    if (it.sessionId != id) it
                    else it.copy(older = (page.items + it.older).distinctBy(Message::id), olderCursor = page.before, olderLoaded = true)
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            } finally {
                mutableState.update { it.copy(loadingOlder = false) }
            }
        }
    }

    // ---- composing and sending ---------------------------------------------------------------------------------

    fun editDraft(text: String) {
        typed = text
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        local.edit().putString(chatDraftKey(api.serverUrl, id), text).apply()
    }

    /** An unsent message goes back to the composer (unless you have already typed something new). */
    private fun restoreDraft(text: String) {
        if (typed.isBlank()) typed = text
        editDraft(typed)
        mutableState.update { it.copy(draft = typed, draftEpoch = it.draftEpoch + 1) }
    }

    fun addAttachment(attachment: AttachmentRef) {
        val attachments = current.attachments
        if (attachments.any { it.versionId == attachment.versionId }) {
            mutableState.update { it.copy(notice = "This file version is already attached.") }
            return
        }
        if (attachments.size >= AttachmentRef.MaxCount || attachments.sumOf { it.size } + attachment.size > AttachmentRef.MaxTotalBytes) {
            mutableState.update { it.copy(notice = "Choose at most 10 files totaling 2 GiB.") }
            return
        }
        updateAttachments(attachments + attachment)
    }

    fun removeAttachment(attachment: AttachmentRef) = updateAttachments(current.attachments - attachment)

    fun setUploading(uploading: Boolean) = mutableState.update { it.copy(uploading = uploading) }

    fun uploadFailed(message: String) = mutableState.update { it.copy(notice = message) }

    private fun updateAttachments(attachments: List<AttachmentRef>) {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        local.edit().putString("${chatDraftKey(api.serverUrl, id)}:attachments", attachmentsJson(attachments)).apply()
        mutableState.update { it.copy(attachments = attachments) }
    }

    private fun loadAttachments(key: String): List<AttachmentRef> {
        val saved = local.getString("$key:attachments", null) ?: return emptyList()
        return runCatching { Json.parseToJsonElement(saved).jsonArray.map { AttachmentRef.fromJson(it.jsonObject) } }.getOrDefault(emptyList())
    }

    fun loadSkills() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        if (current.skillsLoaded) return
        viewModelScope.launch {
            try {
                val skills = api.sessionSkills(id)
                mutableState.update { if (it.sessionId == id) it.copy(skills = skills, skillsLoaded = true) else it }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    fun selectSkill(skill: SkillOption) = mutableState.update {
        if (it.selectedSkills.any { s -> s.id == skill.id }) it else it.copy(selectedSkills = it.selectedSkills + skill)
    }

    fun removeSkill(skill: SkillOption) = mutableState.update { it.copy(selectedSkills = it.selectedSkills - skill) }

    fun send() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        val text = typed.trim()
        val attachments = current.attachments
        if ((text.isEmpty() && attachments.isEmpty()) || current.pending != null || current.uploading) return
        val key = chatDraftKey(api.serverUrl, id)
        val request = UUID.randomUUID().toString()
        val send = PendingSend(request, text, attachments, current.selectedSkills)
        // Saved before the call, so an interrupted send can be checked and retried with the same request id.
        local.edit().putString("$key:request", request).putString("$key:request:text", text)
            .putString("$key:request:attachments", attachmentsJson(attachments))
            .remove(key).remove("$key:attachments").apply()
        typed = ""
        mutableState.update { it.copy(pending = send, draft = "", draftEpoch = it.draftEpoch + 1, attachments = emptyList(), selectedSkills = emptyList()) }
        deliver(api, id, send)
    }

    fun retrySend() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        val send = current.pending?.takeIf { it.failed } ?: return
        mutableState.update { it.copy(pending = send.copy(failed = false, error = null)) }
        viewModelScope.launch {
            // It may have arrived while the answer was lost.
            try {
                if (api.session(id).messages.any { it.requestId == send.requestId }) {
                    clearPending(api, id, send.requestId)
                    return@launch
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // Send again below; the request id keeps it from running twice.
            }
            deliver(api, id, send.copy(failed = false, error = null))
        }
    }

    /** Give up on an unsent message: its text goes back to the composer. */
    fun discardPending() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        val send = current.pending ?: return
        clearPending(api, id, send.requestId)
        restoreDraft(send.text)
        mutableState.update { it.copy(attachments = send.attachments) }
    }

    private fun deliver(api: ReiApi, id: String, send: PendingSend) {
        mutableState.update { it.copy(sending = true) }
        viewModelScope.launch {
            try {
                api.sendMessage(id, send.requestId, send.text, send.attachments, send.skills)
                clearPersisted(api, id, send.requestId)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: ReiApiException) {
                if (failure.status in setOf(401, 426)) {
                    source.reportFailure(failure)
                } else if (failure.status in 400..499 && failure.status != 408) {
                    // Rei refused it: back to the composer with the reason.
                    clearPending(api, id, send.requestId)
                    restoreDraft(send.text)
                    mutableState.update { it.copy(attachments = send.attachments, notice = failure.message) }
                } else {
                    markFailed(id, send.requestId, "Not sent. ${reason(failure)}")
                }
            } catch (failure: Exception) {
                markFailed(id, send.requestId, "Not sent. ${reason(failure)}")
            } finally {
                mutableState.update { it.copy(sending = false) }
            }
        }
    }

    private fun markFailed(id: String, request: String, message: String) {
        mutableState.update {
            if (it.sessionId == id && it.pending?.requestId == request) it.copy(pending = it.pending.copy(failed = true, error = message)) else it
        }
    }

    private fun reconcile(api: ReiApi, id: String, detail: SessionDetail) {
        val pending = current.pending ?: return
        if (detail.messages.any { it.requestId == pending.requestId }) clearPending(api, id, pending.requestId)
    }

    private fun clearPersisted(api: ReiApi, id: String, request: String) {
        val key = chatDraftKey(api.serverUrl, id)
        if (local.getString("$key:request", null) != request) return
        local.edit().remove("$key:request").remove("$key:request:text").remove("$key:request:attachments").apply()
    }

    private fun clearPending(api: ReiApi, id: String, request: String) {
        clearPersisted(api, id, request)
        mutableState.update { if (it.sessionId == id && it.pending?.requestId == request) it.copy(pending = null) else it }
    }

    fun stop() {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        mutableState.update { it.copy(stopping = true) }
        viewModelScope.launch {
            try {
                api.cancel(id)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            } finally {
                mutableState.update { it.copy(stopping = false) }
            }
        }
    }

    fun continueRun() = act { api, id -> api.continueRun(id) }

    // ---- message actions ---------------------------------------------------------------------------------------

    /** Edit a message you wrote: the chat rewinds to just before it and the new text runs there, as a new version. */
    fun edit(message: Message, text: String) = act { api, id ->
        val session = api.editMessage(id, message.id, text)
        if (session.id != id) source.openChat(session.id)
    }

    /** Run your message again from the same point. */
    fun retry(message: Message) = edit(message, message.text)

    fun fork(message: Message) = act { api, id -> source.openChat(api.forkSession(id, message.id).id) }

    fun switchVersion(message: Message, next: Boolean) = act { api, id -> api.switchVersion(id, message.id, next) }

    private fun act(block: suspend (ReiApi, String) -> Unit) {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        viewModelScope.launch {
            try {
                block(api, id)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    /** Decide an approval. The global and chat streams carry the result everywhere; the card reads the answer meanwhile. */
    suspend fun decide(approval: ReiApproval, approve: Boolean, length: String, hours: Int?): ReiApproval {
        val api = source.state.value.api ?: throw IOException("Not connected")
        return api.decideApproval(approval.id, approve, length, hours)
    }

    // ---- agent settings and chat management ---------------------------------------------------------------------

    fun setModel(model: String?) = updateAgent { api, agent -> api.updateAgentSettings(agent.id, model = model, clearModel = model == null) }

    fun setEffort(level: String) = updateAgent { api, agent -> api.updateAgentSettings(agent.id, thinkingLevel = level) }

    private fun updateAgent(block: suspend (ReiApi, ChatAgent) -> ChatAgent) {
        val api = source.state.value.api ?: return
        val agent = current.agent ?: return
        viewModelScope.launch {
            try {
                val updated = block(api, agent)
                mutableState.update { it.copy(agent = updated) }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                fail(failure)
            }
        }
    }

    /** Choose this chat's permission level. [onSaved] runs once Rei has saved it; on failure the level goes back and [ChatUiState.profileError] says why. */
    fun setProfile(next: ChatProfile, onSaved: () -> Unit = {}) {
        val api = source.state.value.api ?: return
        val id = current.sessionId ?: return
        if (current.savingProfile) return
        if (next == current.profile) {
            onSaved()
            return
        }
        mutableState.update { it.startProfileChange(next) }
        viewModelScope.launch {
            try {
                api.updateSessionProfile(id, next)
                mutableState.update { if (it.sessionId == id) it.finishProfileChange(next) else it }
                onSaved()
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                if (failure is ReiApiException && failure.status in setOf(401, 426)) {
                    mutableState.update { if (it.sessionId == id) it.copy(profileChoice = null, savingProfile = false) else it }
                    source.reportFailure(failure)
                } else {
                    mutableState.update { if (it.sessionId == id) it.failProfileChange(reason(failure)) else it }
                }
            }
        }
    }

    fun clearProfileError() = mutableState.update { it.copy(profileError = null) }

    fun setShowDetails(value: Boolean) = details.set(value)

    fun rename(title: String) { current.sessionId?.let { source.renameChat(it, title) } }

    fun pin(pinned: Boolean) { current.sessionId?.let { source.pinChat(it, pinned) } }

    fun delete() { current.sessionId?.let { source.deleteChat(it, deleteForks = false) } }

    fun consumeNotice() = mutableState.update { it.copy(notice = null) }

    fun showNotice(message: String) = mutableState.update { it.copy(notice = message) }

    private fun fail(failure: Exception) {
        if (failure is ReiApiException && failure.status in setOf(401, 426)) {
            source.reportFailure(failure)
        } else {
            mutableState.update { it.copy(notice = reason(failure)) }
        }
    }

    private fun reason(failure: Exception): String = when (failure) {
        is ReiApiException -> failure.message.orEmpty().ifBlank { "Rei could not complete the request." }
        is IOException -> "Couldn’t reach Rei. Check your connection and try again."
        else -> "Rei returned a response this app couldn’t read."
    }

    private fun attachmentsJson(attachments: List<AttachmentRef>) = JsonArray(attachments.map { it.toJson() }).toString()

    companion object {
        fun factory(source: ReiViewModel): ViewModelProvider.Factory = viewModelFactory {
            initializer { ChatViewModel(this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as Application, source) }
        }
    }
}
