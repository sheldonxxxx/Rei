package dev.rei.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.PointF
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.di.AppContainer
import dev.rei.android.di.AppDispatchers
import dev.rei.android.ui.UiText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

internal data class LiveTakeover(val id: String, val status: String, val reason: String?)
internal data class PickOption(val label: String, val value: String, val selected: Boolean)
internal sealed interface BrowserPrompt {
    data class Select(val options: List<PickOption>, val multiple: Boolean) : BrowserPrompt
    data class Dialog(val kind: String, val message: String, val defaultPrompt: String?) : BrowserPrompt
}

private sealed interface SocketEvent {
    data class Text(val raw: String) : SocketEvent
    data class End(val code: Int) : SocketEvent
}

internal class BrowserState {
    var frame by mutableStateOf<Bitmap?>(null)
    var viewport by mutableStateOf(PointF())
    var url by mutableStateOf("")
    var title by mutableStateOf("")
    var control by mutableStateOf(false)
    var ready by mutableStateOf(false)
    var takeover by mutableStateOf<LiveTakeover?>(null)
    var prompt by mutableStateOf<BrowserPrompt?>(null)
    var status by mutableStateOf<UiText?>(UiText.Resource(R.string.browser_status_connecting))
    var socket: WebSocket? = null

    fun disconnected() {
        control = false
        ready = false
        frame = null
        prompt = null
    }

    fun send(type: String, fields: JsonObjectBuilder.() -> Unit) {
        if (!control || !ready) return
        socket?.send(buildJsonObject {
            put("type", type)
            fields()
        }.toString())
    }

    fun applyTakeover(data: JsonObject) {
        val current = data["takeover"] as? JsonObject
        takeover = current?.let {
            LiveTakeover(it.optionalString("id").orEmpty(), it.optionalString("status").orEmpty(), it.optionalString("reason"))
        }
    }

    fun text(raw: String): String? {
        val message = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
        fun updatePage() {
            url = message.optionalString("url").orEmpty()
            title = message.optionalString("title").orEmpty()
        }
        fun updateViewport(data: JsonObject) {
            val w = data.optionalString("width")?.toFloatOrNull() ?: return
            val h = data.optionalString("height")?.toFloatOrNull() ?: return
            if (w > 0 && h > 0) viewport = PointF(w, h)
        }
        when (message.optionalString("type")) {
            "hello" -> {
                updatePage()
                (message["viewport"] as? JsonObject)?.let(::updateViewport)
                control = message.optionalString("control") == "true"
                ready = true
                status = null
            }
            "page" -> updatePage()
            "viewport" -> updateViewport(message)
            "control" -> {
                control = message.optionalString("control") == "true"
                if (!control) prompt = null
            }
            "select" -> if (control) {
                prompt = BrowserPrompt.Select(
                    message.objects("options").map {
                        PickOption(
                            it.optionalString("label").orEmpty(),
                            it.optionalString("value").orEmpty(),
                            it.optionalString("selected") == "true",
                        )
                    },
                    message.optionalString("multiple") == "true",
                )
            }
            "dialog" -> if (control) {
                prompt = BrowserPrompt.Dialog(
                    message.optionalString("kind").orEmpty(),
                    message.optionalString("message").orEmpty(),
                    message.optionalString("defaultPrompt"),
                )
            }
            "closed" -> return message.optionalString("reason") ?: "closed"
        }
        return null
    }
}

/**
 * Owns the live remote-browser WebSocket, decoded viewport frames, and takeover mutations in [viewModelScope]
 * so rotating the device never tears down the stream or aborts an in-flight takeover action.
 */
internal class BrowserViewModel(
    sessionId: String,
    private val session: SessionRepository,
    private val dispatchers: AppDispatchers = AppDispatchers(),
) : ViewModel() {
    val state = BrowserState()
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<UiText?>(null)
        private set
    var ending by mutableStateOf(false)

    private val path = listOf("api", "sessions", sessionId, "browser")
    private val retryTick = MutableStateFlow(0)

    init {
        viewModelScope.launch {
            combine(session.api, session.inForeground, retryTick) { api, foreground, tick ->
                Triple(api, foreground, tick)
            }.distinctUntilChanged().collectLatest { (api, foreground, _) ->
                if (api == null || !foreground) {
                    state.disconnected()
                    return@collectLatest
                }
                collectLive(api)
            }
        }
    }

    fun reconnect() {
        retryTick.value += 1
    }

    fun takeOver() {
        val api = session.currentApi ?: return
        act(api) {
            try {
                state.applyTakeover(api.request("POST", path + "takeover"))
            } catch (e: ReiApiException) {
                if (e.code != "already_active") throw e
                refresh(api)
            }
        }
    }

    fun requestReturnControl() {
        val api = session.currentApi ?: return
        if (state.takeover == null) {
            act(api) {
                refresh(api)
                ending = state.takeover != null
            }
        } else {
            ending = true
        }
    }

    fun endTakeover(action: String, note: String) {
        val api = session.currentApi ?: return
        val takeover = state.takeover ?: return
        act(api) {
            api.request("POST", listOf("api", "takeovers", takeover.id, "end"), buildJsonObject {
                put("action", action)
                if (note.isNotBlank()) put("note", note.trim().take(500))
            })
            state.takeover = null
            ending = false
        }
    }

    private fun act(api: ReiApi, action: suspend () -> Unit) {
        if (busy) return
        viewModelScope.launch {
            busy = true
            error = null
            try {
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ReiApiException) {
                if (e.status in setOf(401, 426)) {
                    session.reportFailure(e)
                } else {
                    error = UiText.Literal(e.message.orEmpty())
                    refresh(api)
                }
            } catch (_: Exception) {
                error = UiText.Resource(R.string.browser_action_failed)
            } finally {
                busy = false
            }
        }
    }

    private suspend fun refresh(api: ReiApi) {
        try {
            state.applyTakeover(api.request("GET", path))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The live connection reports availability. Failed refreshes can be retried from the toolbar.
        }
    }

    private suspend fun collectLive(api: ReiApi) {
        var retryMs = 500L
        while (true) {
            state.disconnected()
            state.status = UiText.Resource(if (retryMs == 500L) R.string.browser_status_connecting else R.string.browser_status_reconnecting)
            val events = Channel<SocketEvent>(32)
            val frames = Channel<ByteString>(Channel.CONFLATED)
            val connection = api.websocket(path + "live", object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (events.trySend(SocketEvent.Text(text)).isFailure) {
                        events.close()
                        webSocket.cancel()
                    }
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    frames.trySend(bytes)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    events.trySend(SocketEvent.End(code))
                    events.close()
                    webSocket.close(code.takeIf { it != 1005 } ?: 1000, null)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    events.trySend(SocketEvent.End(response?.code ?: 0))
                    events.close()
                }
            })
            state.socket = connection
            var retry = true
            try {
                coroutineScope {
                    var refreshJob: Job? = null
                    val frameReader = launch {
                        for (bytes in frames) {
                            val image = withContext(dispatchers.default) {
                                val raw = bytes.toByteArray()
                                BitmapFactory.decodeByteArray(raw, 0, raw.size)
                            }
                            if (image != null) state.frame = image
                        }
                    }
                    try {
                        for (event in events) {
                            when (event) {
                                is SocketEvent.Text -> {
                                    val wasReady = state.ready
                                    val previousControl = state.control
                                    val closed = runCatching { state.text(event.raw) }.getOrNull()
                                    if (closed != null) {
                                        retry = closed == "restarted" || closed == "crashed"
                                        state.status = UiText.Resource(
                                            if (closed == "no_window") R.string.browser_status_no_window else R.string.browser_status_closed,
                                        )
                                        break
                                    }
                                    if (state.ready && (!wasReady || state.control != previousControl)) {
                                        retryMs = 500L
                                        refreshJob?.cancel()
                                        refreshJob = launch { refresh(api) }
                                    }
                                }
                                is SocketEvent.End -> {
                                    if (event.code in setOf(401, 403, 404, 426, 4401)) {
                                        retry = false
                                        state.status = UiText.Resource(
                                            if (event.code == 426) R.string.browser_status_outdated else R.string.browser_status_denied,
                                        )
                                    }
                                    break
                                }
                            }
                        }
                    } finally {
                        frameReader.cancel()
                        refreshJob?.cancel()
                    }
                }
            } finally {
                state.socket = null
                connection.cancel()
                events.cancel()
                frames.cancel()
                state.disconnected()
            }
            if (!retry) return
            state.status = UiText.Resource(R.string.browser_status_reconnecting)
            delay(retryMs)
            retryMs = (retryMs * 2).coerceAtMost(8_000)
        }
    }

    companion object {
        fun factory(sessionId: String, container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                BrowserViewModel(
                    sessionId = sessionId,
                    session = container.sessionRepository,
                    dispatchers = container.dispatchers,
                )
            }
        }
    }
}
