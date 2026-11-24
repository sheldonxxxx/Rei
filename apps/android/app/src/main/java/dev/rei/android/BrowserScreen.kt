package dev.rei.android

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.RectF
import android.text.Editable
import android.text.InputType
import android.text.Selection
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.icons.ReiIcons
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

private data class LiveTakeover(val id: String, val status: String, val reason: String?)
private data class PickOption(val label: String, val value: String, val selected: Boolean)
private sealed interface BrowserPrompt {
    data class Select(val options: List<PickOption>, val multiple: Boolean) : BrowserPrompt
    data class Dialog(val kind: String, val message: String, val defaultPrompt: String?) : BrowserPrompt
}
private sealed interface SocketEvent {
    data class Text(val raw: String) : SocketEvent
    data class End(val code: Int) : SocketEvent
}

private class BrowserState {
    var frame by mutableStateOf<Bitmap?>(null)
    var viewport by mutableStateOf(PointF())
    var url by mutableStateOf("")
    var title by mutableStateOf("")
    var control by mutableStateOf(false)
    var ready by mutableStateOf(false)
    var takeover by mutableStateOf<LiveTakeover?>(null)
    var prompt by mutableStateOf<BrowserPrompt?>(null)
    var status by mutableStateOf("Connecting…")
    var socket: WebSocket? = null

    fun disconnected() {
        control = false
        ready = false
        frame = null
        prompt = null
    }

    fun send(type: String, fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) {
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
                status = ""
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
                    message.optionalString("kind").orEmpty(), message.optionalString("message").orEmpty(),
                    message.optionalString("defaultPrompt"),
                )
            }
            "closed" -> return message.optionalString("reason") ?: "closed"
        }
        return null
    }
}

private suspend fun BrowserState.collectLive(api: ReiApi, path: List<String>, refresh: suspend () -> Unit) {
    var retryMs = 500L
    while (true) {
        disconnected()
        status = if (retryMs == 500L) "Connecting…" else "Reconnecting…"
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
        socket = connection
        var retry = true
        try {
            coroutineScope {
                var refreshJob: Job? = null
                val frameReader = launch {
                    for (bytes in frames) {
                        val image = withContext(Dispatchers.Default) {
                            val raw = bytes.toByteArray()
                            BitmapFactory.decodeByteArray(raw, 0, raw.size)
                        }
                        if (image != null) frame = image
                    }
                }
                try {
                    for (event in events) {
                        when (event) {
                            is SocketEvent.Text -> {
                                val wasReady = ready
                                val previousControl = control
                                val closed = runCatching { text(event.raw) }.getOrNull()
                                if (closed != null) {
                                    retry = closed == "restarted" || closed == "crashed"
                                    status = if (closed == "no_window") "This chat has no browser window." else "The browser window closed."
                                    break
                                }
                                if (ready && (!wasReady || control != previousControl)) {
                                    retryMs = 500L
                                    refreshJob?.cancel()
                                    refreshJob = launch { refresh() }
                                }
                            }
                            is SocketEvent.End -> {
                                if (event.code in setOf(401, 403, 404, 426, 4401)) {
                                    retry = false
                                    status = if (event.code == 426) "Update Rei to open the live browser."
                                    else "Rei denied access to this browser window."
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
            socket = null
            connection.cancel()
            events.cancel()
            frames.cancel()
            disconnected()
        }
        if (!retry) return
        status = "Reconnecting…"
        delay(retryMs)
        retryMs = (retryMs * 2).coerceAtMost(8_000)
    }
}

@Composable
fun BrowserScreen(api: ReiApi, sessionId: String, onBack: () -> Unit) {
    val state = remember(api, sessionId) { BrowserState() }
    val path = remember(sessionId) { listOf("api", "sessions", sessionId, "browser") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var liveView by remember { mutableStateOf<RemoteViewport?>(null) }
    var retry by remember { mutableStateOf(0) }
    var busy by remember(api, sessionId) { mutableStateOf(false) }
    var error by remember(api, sessionId) { mutableStateOf<String?>(null) }
    var dragging by remember { mutableStateOf(false) }
    var editAddress by remember { mutableStateOf(false) }
    var ending by remember { mutableStateOf(false) }

    suspend fun refresh() {
        try {
            state.applyTakeover(api.request("GET", path))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The live connection reports availability. Failed refreshes can be retried from the toolbar.
        }
    }

    LaunchedEffect(api, sessionId, retry, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            state.collectLive(api, path, ::refresh)
        }
    }

    fun act(action: suspend () -> Unit) {
        if (busy) return
        scope.launch {
            busy = true
            error = null
            try {
                action()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ReiApiException) {
                error = e.message
                refresh()
            } catch (_: Exception) {
                error = "The browser action failed."
            } finally {
                busy = false
            }
        }
    }

    fun end(action: String, note: String) {
        val takeover = state.takeover ?: return
        act {
            api.request("POST", listOf("api", "takeovers", takeover.id, "end"), buildJsonObject {
                put("action", action)
                if (note.isNotBlank()) put("note", note.trim().take(500))
            })
            state.takeover = null
            ending = false
        }
    }

    Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
        Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            ReiIconButton(ReiIcons.Back, "Close browser", onBack)
            Column(Modifier.weight(1f)) {
                Text(state.title.ifBlank { "Browser" }, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (state.url.isNotBlank()) {
                    Text(
                        state.url,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (state.control) {
                ReiIconButton(ReiIcons.Back, "Page back", { state.send("nav") { put("action", "back") } })
                ReiIconButton(ReiIcons.Forward, "Page forward", { state.send("nav") { put("action", "forward") } })
                ReiIconButton(ReiIcons.Reload, "Reload page", { state.send("nav") { put("action", "reload") } })
            }
            when {
                state.control -> Button(
                    onClick = { if (state.takeover == null) act { refresh(); ending = state.takeover != null } else ending = true },
                    enabled = !busy,
                    modifier = Modifier.padding(start = 4.dp, end = 8.dp).heightIn(min = 48.dp),
                ) { Text("Return control") }
                state.ready -> Button(onClick = {
                    act {
                        try {
                            state.applyTakeover(api.request("POST", path + "takeover"))
                        } catch (e: ReiApiException) {
                            if (e.code != "already_active") throw e
                            refresh()
                        }
                    }
                }, enabled = !busy, modifier = Modifier.padding(start = 4.dp, end = 8.dp).heightIn(min = 48.dp)) { Text("Take over") }
            }
        }

        state.takeover?.takeIf { state.ready && it.status == "pending" }?.let { request ->
            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(request.reason ?: "The agent requested browser takeover.", Modifier.weight(1f))
                TextButton(onClick = { ending = true }, enabled = !busy) { Text("Decline") }
            }
        }
        error?.let { Text(it, Modifier.padding(horizontal = 12.dp), color = MaterialTheme.colorScheme.error) }

        if (state.control) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { editAddress = true }) { Text("Address") }
                TextButton(onClick = { liveView?.showKeyboard() }) { Text("Keyboard") }
                TextButton(onClick = { liveView?.press("Tab") }) { Text("Tab") }
                TextButton(onClick = { liveView?.press("Escape") }) { Text("Escape") }
                val clipboard = context.getSystemService(ClipboardManager::class.java)
                TextButton(onClick = {
                    if (clipboard?.primaryClipDescription?.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) == true) {
                        clipboard.primaryClip?.getItemAt(0)?.text?.toString()?.let { liveView?.sendText(it) }
                    }
                }) { Text("Paste") }
                FilterChip(selected = dragging, onClick = { dragging = !dragging }, label = { Text("Drag") })
                TextButton(onClick = { liveView?.resetZoom() }) { Text("Reset zoom") }
            }
        }

        Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
            AndroidView(
                factory = { RemoteViewport(it).also { view -> liveView = view } },
                modifier = Modifier.fillMaxSize(),
                update = {
                    it.browser = state
                    it.dragging = dragging
                    it.updateImage(state.frame, state.viewport, state.control)
                },
            )
            if (!state.ready || state.frame == null) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(state.status.ifBlank { "Waiting for a browser frame…" }, color = androidx.compose.ui.graphics.Color.White)
                    if (!state.ready) TextButton(onClick = { retry++ }) { Text("Reconnect") }
                }
            }
        }
    }

    if (editAddress && state.control) {
        var address by remember { mutableStateOf(state.url) }
        AlertDialog(
            onDismissRequest = { editAddress = false },
            title = { Text("Open address") },
            text = { OutlinedTextField(address, { address = it }, singleLine = true, label = { Text("Address") }) },
            confirmButton = {
                TextButton(onClick = {
                    state.send("goto") { put("url", address.trim()) }
                    editAddress = false
                }, enabled = address.isNotBlank() && address.length <= 2_000) { Text("Open") }
            },
            dismissButton = { TextButton(onClick = { editAddress = false }) { Text("Cancel") } },
        )
    }

    if (ending && state.takeover != null) {
        var note by remember { mutableStateOf("") }
        val pending = state.takeover?.status == "pending"
        AlertDialog(
            onDismissRequest = { if (!busy) ending = false },
            title = { Text(if (pending) "Decline takeover" else "Return control") },
            text = { OutlinedTextField(note, { note = it.take(500) }, label = { Text("Note to agent (optional)") }) },
            confirmButton = {
                Button(onClick = { end(if (pending) "cancel" else "done", note) }, enabled = !busy) {
                    Text(if (pending) "Decline" else "Done")
                }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { ending = false }, enabled = !busy) { Text("Keep open") }
                    if (!pending) TextButton(onClick = { end("cancel", note) }, enabled = !busy) { Text("Cancel takeover") }
                }
            },
        )
    }

    state.prompt?.let { prompt ->
        val dialog = prompt as? BrowserPrompt.Dialog
        val select = prompt as? BrowserPrompt.Select
        var answer by remember(prompt) { mutableStateOf(dialog?.defaultPrompt.orEmpty()) }
        var selected by remember(prompt) { mutableStateOf(select?.options.orEmpty().filter { it.selected }.map { it.value }.toSet()) }
        fun respond(accept: Boolean) {
            if (dialog != null) state.send("dialog") {
                put("accept", accept)
                if (accept && dialog.kind == "prompt") put("text", answer.take(1_500))
            }
            if (accept && select != null) state.send("select") {
                put("values", buildJsonArray { selected.take(200).forEach { add(JsonPrimitive(it)) } })
            }
            state.prompt = null
        }
        AlertDialog(
            onDismissRequest = { respond(dialog?.kind == "alert") },
            title = { Text(if (select != null) "Select options" else "Browser dialog") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    dialog?.let {
                        Text(it.message)
                        if (it.kind == "prompt") OutlinedTextField(answer, { answer = it }, label = { Text("Answer") })
                    }
                    select?.options?.forEach { option ->
                        if (select.multiple) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(option.value in selected, {
                                    selected = if (it) selected + option.value else selected - option.value
                                })
                                Text(option.label)
                            }
                        } else {
                            TextButton(onClick = {
                                selected = setOf(option.value)
                                respond(true)
                            }) { Text(option.label) }
                        }
                    }
                }
            },
            confirmButton = {
                if (select?.multiple != false) TextButton(onClick = { respond(true) }) { Text("OK") }
            },
            dismissButton = {
                if (dialog?.kind != "alert") TextButton(onClick = { respond(false) }) { Text("Cancel") }
            },
        )
    }
}

/** Draws the newest JPEG and maps input through the exact rectangle used to render it. */
private class RemoteViewport(context: Context) : View(context) {
    var browser: BrowserState? = null
    var dragging = false
    private var bitmap: Bitmap? = null
    private var viewport = PointF()
    private var controlling = false
    private var zoom = 1f
    private val pan = PointF()
    private val rect = RectF()
    private var frameArea: FrameArea? = null
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private var multiTouch = false
    private var lastCenter: PointF? = null
    private var held: PointF? = null
    private val keyboard = context.getSystemService(InputMethodManager::class.java)

    init {
        isFocusableInTouchMode = true
        contentDescription = "Live browser page"
    }

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            val point = source(e.x, e.y) ?: return false
            click(point, "left", 1)
            performClick()
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            val point = source(e.x, e.y) ?: return false
            click(point, "left", 1)
            click(point, "left", 2)
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            if (!multiTouch) source(e.x, e.y)?.let { click(it, "right", 1) }
        }

        override fun onScroll(down: MotionEvent?, e: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            if (multiTouch || down == null) return false
            val start = source(down.x, down.y) ?: return false
            val point = source(e.x, e.y, clamp = dragging) ?: return false
            if (dragging) {
                if (held == null) mouse("down", start, "left", 1)
                held = point
                mouse("move", point, "left", 0)
            } else if (!rect.isEmpty) {
                wheel(point, distanceX * viewport.x / rect.width(), distanceY * viewport.y / rect.height())
            }
            return true
        }
    })

    private val pinch = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val next = (zoom * detector.scaleFactor).coerceIn(1f, 5f)
            if (next == zoom) return true
            val ratio = next / zoom
            pan.x += (detector.focusX - rect.centerX()) * (1 - ratio)
            pan.y += (detector.focusY - rect.centerY()) * (1 - ratio)
            zoom = next
            layoutFrame()
            invalidate()
            return true
        }
    }).also { it.isQuickScaleEnabled = false }

    fun updateImage(image: Bitmap?, newViewport: PointF, control: Boolean) {
        if (controlling && !control) {
            held = null
            keyboard?.hideSoftInputFromWindow(windowToken, 0)
            clearFocus()
        }
        controlling = control
        bitmap = image
        if (viewport != newViewport) {
            viewport = newViewport
            resetZoom()
        }
        invalidate()
    }

    fun resetZoom() {
        zoom = 1f
        pan.set(0f, 0f)
        layoutFrame()
        invalidate()
    }

    private fun layoutFrame() {
        if (viewport.x <= 0 || viewport.y <= 0 || width == 0 || height == 0) {
            frameArea = null
            rect.setEmpty()
            return
        }
        val area = FrameArea.fit(width.toFloat(), height.toFloat(), viewport.x, viewport.y, zoom, pan.x, pan.y)
        frameArea = area
        pan.set(area.panX, area.panY)
        rect.set(area.left, area.top, area.left + area.width, area.top + area.height)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = layoutFrame()
    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Color.BLACK)
        bitmap?.let { if (!rect.isEmpty) canvas.drawBitmap(it, null, rect, paint) }
    }

    private fun source(x: Float, y: Float, clamp: Boolean = false): PointF? =
        frameArea?.source(x, y, viewport.x, viewport.y, clamp)?.let { (sx, sy) -> PointF(sx, sy) }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                multiTouch = false
                lastCenter = null
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (!multiTouch) {
                    val cancel = MotionEvent.obtain(event)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    gestures.onTouchEvent(cancel)
                    cancel.recycle()
                    releaseDrag()
                }
                multiTouch = true
            }
        }
        pinch.onTouchEvent(event)
        if (multiTouch && event.actionMasked == MotionEvent.ACTION_MOVE && event.pointerCount >= 2) {
            val middle = PointF((event.getX(0) + event.getX(1)) / 2, (event.getY(0) + event.getY(1)) / 2)
            lastCenter?.let {
                pan.offset(middle.x - it.x, middle.y - it.y)
                layoutFrame()
                invalidate()
            }
            lastCenter = middle
        } else if (event.actionMasked == MotionEvent.ACTION_POINTER_UP) {
            lastCenter = null
        }
        if (controlling && !multiTouch && bitmap != null) gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) releaseDrag()
        return true
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (!controlling || bitmap == null) return super.onGenericMotionEvent(event)
        val point = source(event.x, event.y) ?: return super.onGenericMotionEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_SCROLL -> wheel(point, -event.getAxisValue(MotionEvent.AXIS_HSCROLL) * 64, -event.getAxisValue(MotionEvent.AXIS_VSCROLL) * 64)
            MotionEvent.ACTION_HOVER_MOVE -> mouse("move", point, "left", 0)
            MotionEvent.ACTION_BUTTON_PRESS -> when (event.actionButton) {
                MotionEvent.BUTTON_SECONDARY -> click(point, "right", 1)
                MotionEvent.BUTTON_TERTIARY -> click(point, "middle", 1)
                else -> return super.onGenericMotionEvent(event)
            }
            else -> return super.onGenericMotionEvent(event)
        }
        return true
    }

    private fun releaseDrag() {
        held?.let { mouse("up", it, "left", 1) }
        held = null
    }

    private fun click(point: PointF, button: String, count: Int) {
        mouse("down", point, button, count)
        mouse("up", point, button, count)
    }

    private fun mouse(action: String, point: PointF, button: String, count: Int) {
        browser?.send("mouse") {
            put("action", action)
            put("x", point.x)
            put("y", point.y)
            put("button", button)
            put("clickCount", count)
        }
    }

    private fun wheel(point: PointF, dx: Float, dy: Float) {
        browser?.send("wheel") {
            put("x", point.x)
            put("y", point.y)
            put("dx", dx)
            put("dy", dy)
        }
    }

    fun showKeyboard() {
        if (!controlling) return
        requestFocus()
        keyboard?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }

    fun sendText(text: CharSequence) {
        var first = 0
        while (first < text.length) {
            var last = (first + 1_500).coerceAtMost(text.length)
            if (last < text.length && text[last - 1].isHighSurrogate()) last--
            browser?.send("text") { put("text", text.subSequence(first, last).toString()) }
            first = last
        }
    }

    override fun onCheckIsTextEditor() = controlling

    override fun onCreateInputConnection(outAttrs: EditorInfo): BaseInputConnection? {
        if (!controlling) return null
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_ACTION_GO or EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        return object : BaseInputConnection(this, true) {
            private val composition = Editable.Factory.getInstance().newEditable("").also {
                Selection.setSelection(it, 0)
            }
            override fun getEditable(): Editable = composition

            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                if (!text.isNullOrEmpty()) this@RemoteViewport.sendText(text)
                composition.clear()
                Selection.setSelection(composition, 0)
                removeComposingSpans(composition)
                return true
            }

            override fun finishComposingText(): Boolean {
                if (composition.isNotEmpty()) this@RemoteViewport.sendText(composition)
                composition.clear()
                Selection.setSelection(composition, 0)
                return super.finishComposingText()
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (composition.isNotEmpty()) return super.deleteSurroundingText(beforeLength, afterLength)
                repeat(beforeLength.coerceIn(0, 32)) { press("Backspace") }
                repeat(afterLength.coerceIn(0, 32)) { press("Delete") }
                return true
            }

            override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
                deleteSurroundingText(beforeLength, afterLength)

            override fun performEditorAction(actionCode: Int): Boolean {
                finishComposingText()
                press("Enter", "\r")
                return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        handleKey(event, "down") || super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        handleKey(event, "up") || super.onKeyUp(keyCode, event)

    private fun handleKey(event: KeyEvent, action: String): Boolean {
        if (!controlling) return false
        val code = event.keyCode
        val special = when (code) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
            KeyEvent.KEYCODE_TAB -> "Tab"
            KeyEvent.KEYCODE_DEL -> "Backspace"
            KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
            KeyEvent.KEYCODE_ESCAPE -> "Escape"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_MOVE_HOME -> "Home"
            KeyEvent.KEYCODE_MOVE_END -> "End"
            KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
            KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
            else -> null
        }
        val character = event.getUnicodeChar(event.metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_META_MASK).inv())
            .takeIf { Character.isValidCodePoint(it) && !Character.isISOControl(it) }
            ?.let { String(Character.toChars(it)) }
        val key = special ?: character ?: return false
        val domCode = when (code) {
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key${'A' + (code - KeyEvent.KEYCODE_A)}"
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit${code - KeyEvent.KEYCODE_0}"
            KeyEvent.KEYCODE_SPACE -> "Space"
            else -> special.orEmpty()
        }
        val modifiers = (if (event.isAltPressed) 1 else 0) or (if (event.isCtrlPressed) 2 else 0) or
            (if (event.isMetaPressed) 4 else 0) or (if (event.isShiftPressed) 8 else 0)
        val text = if (action != "down" || event.isCtrlPressed || event.isMetaPressed) null
        else if (special == "Enter") "\r" else if (special == null) character else null
        sendKey(action, key, domCode, modifiers, text)
        return true
    }

    fun press(key: String, text: String? = null) {
        sendKey("down", key, key, 0, text)
        sendKey("up", key, key, 0, null)
    }

    private fun sendKey(action: String, key: String, code: String, modifiers: Int, text: String?) {
        browser?.send("key") {
            put("action", action)
            put("key", key)
            put("code", code)
            put("modifiers", modifiers)
            if (text != null) put("text", text)
        }
    }
}

internal data class FrameArea(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
    val panX: Float,
    val panY: Float,
) {
    fun source(x: Float, y: Float, viewportWidth: Float, viewportHeight: Float, clamp: Boolean): Pair<Float, Float>? {
        if (!clamp && (x < left || x >= left + width || y < top || y >= top + height)) return null
        val sx = ((x - left) / width * viewportWidth).coerceIn(0f, viewportWidth - 1)
        val sy = ((y - top) / height * viewportHeight).coerceIn(0f, viewportHeight - 1)
        return sx to sy
    }

    companion object {
        fun fit(
            width: Float, height: Float, viewportWidth: Float, viewportHeight: Float,
            zoom: Float, panX: Float, panY: Float,
        ): FrameArea {
            val scale = minOf(width / viewportWidth, height / viewportHeight) * zoom
            val frameWidth = viewportWidth * scale
            val frameHeight = viewportHeight * scale
            val limitX = ((frameWidth - width) / 2).coerceAtLeast(0f)
            val limitY = ((frameHeight - height) / 2).coerceAtLeast(0f)
            val x = panX.coerceIn(-limitX, limitX)
            val y = panY.coerceIn(-limitY, limitY)
            return FrameArea((width - frameWidth) / 2 + x, (height - frameHeight) / 2 + y, frameWidth, frameHeight, x, y)
        }
    }
}
