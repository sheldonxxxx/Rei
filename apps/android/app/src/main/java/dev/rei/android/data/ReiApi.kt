package dev.rei.android.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

class ReiApiException(val status: Int, val code: String, message: String) : IOException(message)

class ReiApi(serverUrl: String, private val token: String? = null) {
    private val base = serverUrl.trim().toHttpUrlOrNull()?.also { url ->
        require(url.username.isEmpty() && url.password.isEmpty() &&
            url.query == null && url.fragment == null && url.encodedPath == "/") {
            "Enter the Rei server address without a path or credentials."
        }
        require(url.isHttps || url.host in setOf("localhost", "127.0.0.1", "::1")) {
            "Use HTTPS to connect to a Rei server."
        }
    } ?: throw IllegalArgumentException("Enter a valid Rei server address.")

    val serverUrl: String = base.toString().removeSuffix("/")
    val client: OkHttpClient get() = http

    suspend fun health(): Health {
        val body = request("GET", listOf("api", "health"))
        if (body.optionalString("ok") != "true") {
            throw ReiApiException(0, "invalid_response", "This address did not return a Rei health response.")
        }
        val health = Health(
            body.getValue("protocolVersion").jsonPrimitive.int,
            body.getValue("minClientProtocol").jsonPrimitive.int,
        )
        if (health.minClientProtocol > PROTOCOL) {
            throw ReiApiException(426, "client_outdated", "Update the Rei Android app to connect to this server.")
        }
        return health
    }

    suspend fun authState(): AuthState = request("GET", listOf("api", "auth", "state")).authState()

    suspend fun login(password: String, totpCode: String? = null, deviceLabel: String = "Android"): String =
        request("POST", listOf("api", "auth", "login"), buildJsonObject {
            put("password", password)
            put("deviceLabel", deviceLabel)
            if (!totpCode.isNullOrBlank()) put("totpCode", totpCode)
        }).signInToken()

    suspend fun setup(setupCode: String, password: String, deviceLabel: String = "Android"): String =
        request("POST", listOf("api", "auth", "setup"), buildJsonObject {
            put("setupCode", setupCode)
            put("password", password)
            put("deviceLabel", deviceLabel)
        }).signInToken()

    suspend fun logout() {
        request("POST", listOf("api", "auth", "logout"))
    }

    suspend fun sessions(before: String? = null, agentId: String? = null): SessionsPage {
        val query = buildMap {
            put("paged", "1")
            if (agentId != null) put("agent", agentId)
            if (before != null) put("before", before)
        }
        val body = request("GET", listOf("api", "sessions"), query = query)
        return SessionsPage(body.objects("sessions").map { it.session() }, body.optionalString("nextCursor"))
    }

    suspend fun createSession(agentId: String? = null): Session =
        request("POST", listOf("api", "sessions"), buildJsonObject {
            if (agentId != null) put("agentId", agentId)
        }).obj("session").session()

    suspend fun session(id: String): SessionDetail =
        request("GET", sessionPath(id)).conversation("messages").detail()

    suspend fun transcript(id: String, before: String): TranscriptPage {
        val body = request("GET", sessionPath(id) + "transcript", query = mapOf("before" to before))
        return TranscriptPage(body.objects("items").map { it.message() }, body.optionalString("before"))
    }

    suspend fun uploadAttachment(sessionId: String, filename: String, file: RequestBody): AttachmentRef {
        return AttachmentRef.fromJson(uploadFile(sessionPath(sessionId) + "attachments", filename, file).obj("attachment"))
    }

    suspend fun uploadFile(path: List<String>, filename: String, file: RequestBody, query: Map<String,String> = emptyMap()): JsonObject {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", filename, file).build()
        return execute(authenticatedRequest(path, query).header("Accept", "application/json").post(body).build())
    }

    suspend fun libraryFiles(search: String = "", cursor: String? = null): LibraryPage {
        val query = buildMap {
            if (search.isNotBlank()) put("q", search.trim())
            if (cursor != null) put("cursor", cursor)
        }
        val body = request("GET", listOf("api", "files"), query = query)
        return LibraryPage(
            files = body.objects("files").map { file ->
                AttachmentRef.fromJson(file.obj("current")).copy(name = file.string("name"))
            },
            nextCursor = body.optionalString("nextCursor"),
        )
    }

    suspend fun approvals(): List<ReiApproval> =
        request("GET", listOf("api", "approvals")).objects("approvals").map { it.approval() }

    suspend fun decideApproval(id: String, approve: Boolean, length: String = "once", hours: Int? = null): ReiApproval =
        request("POST", listOf("api", "approvals", id, "decide"), buildJsonObject {
            put("decision", if (approve) "approve" else "deny")
            if (approve) {
                put("length", length)
                if (length == "hours" && hours != null) put("hours", hours)
            }
        }).obj("approval").approval()

    suspend fun sendMessage(
        id: String,
        requestId: String,
        text: String,
        attachments: List<AttachmentRef> = emptyList(),
        skills: List<SkillOption> = emptyList(),
    ) {
        val body = buildJsonObject {
            put("requestId", requestId)
            put("text", text)
            if (attachments.isNotEmpty()) put("files", JsonArray(attachments.map { attachment ->
                buildJsonObject {
                    put("fileId", attachment.fileId)
                    put("versionId", attachment.versionId)
                }
            }))
            if (skills.isNotEmpty()) put("selectedSkills", skillsJson(skills))
        }
        for (attempt in 0..3) {
            try {
                request("POST", sessionPath(id) + "messages", body)
                return
            } catch (failure: ReiApiException) {
                if (attempt == 3 || failure.status !in retryable) throw failure
                delay(500L shl attempt)
            }
        }
    }

    suspend fun forkSession(sessionId: String, messageId: String): Session =
        request("POST", sessionPath(sessionId) + "fork", buildJsonObject {
            put("messageId", messageId)
        }).obj("session").session()

    suspend fun editMessage(sessionId: String, messageId: String, text: String): Session =
        request("POST", sessionPath(sessionId) + "edit", buildJsonObject {
            put("messageId", messageId)
            put("text", text)
        }).obj("session").session()

    fun fileRequest(fileId: String, versionId: String, thumbnail: Boolean = false): Request =
        authenticatedRequest(
            listOf("api", "files", fileId, "versions", versionId, "content"),
            if (thumbnail) mapOf("thumbnail" to "1") else emptyMap(),
        ).build()

    suspend fun cancel(id: String) {
        request("POST", sessionPath(id) + "cancel")
    }

    suspend fun compactSession(id: String, requestId: String, instructions: String? = null) {
        val body = buildJsonObject {
            put("requestId", requestId)
            if (!instructions.isNullOrBlank()) put("instructions", instructions.trim())
        }
        request("POST", sessionPath(id) + "compact", body)
    }

    suspend fun markRead(id: String, itemId: String, at: Long) {
        request("PUT", sessionPath(id) + "read-marker", buildJsonObject {
            put("itemId", itemId)
            put("at", at)
        })
    }

    suspend fun presence(visible: Boolean, idleMs: Long? = null) {
        request("POST", listOf("api", "devices", "current", "presence"), buildJsonObject {
            put("visible", visible)
            if (idleMs != null) put("idleMs", idleMs)
        })
    }

    /**
     * The open chat's live view. [connection] is told when the stream is up (`true`, with every event) and when it dropped
     * and is being re-established (`false`), so a screen can say "Reconnecting".
     */
    fun stream(id: String, connection: ((Boolean) -> Unit)? = null): Flow<SessionEvent> = flow {
        var backoff = 500L
        while (true) {
            val state = ConversationStream()
            var removed = false
            reconnectable {
                frames(sessionPath(id) + "stream").firstOrNull { frame ->
                    if (frame.type !in sessionEventTypes) return@firstOrNull false
                    val event = state.apply(frame.type, frame.payload()) ?: return@firstOrNull true
                    connection?.invoke(true)
                    emit(event)
                    backoff = 500L
                    removed = event is SessionEvent.Removed
                    removed
                }
            }
            if (removed) return@flow
            connection?.invoke(false)
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(8_000)
        }
    }

    fun globalStream(): Flow<GlobalEvent> = flow {
        var cursor: String? = null
        var backoff = 500L
        while (true) {
            reconnectable {
                frames(listOf("api", "stream"), cursor).collect { frame ->
                    when (frame.type) {
                        "snapshot" -> {
                            val data = frame.payload()
                            val agentId = data.string("defaultAgentId")
                            val agents = data.objects("agents").map { it.chatAgent() }
                            val homeId = agents.firstOrNull { it.id == agentId }
                                ?.homeSessionId ?: data.obj("companion").string("homeSessionId")
                            emit(
                                GlobalEvent.Snapshot(
                                    sessions = data.objects("sessions").map { it.session() },
                                    defaultAgentId = agentId,
                                    homeSessionId = homeId,
                                    agents = agents,
                                    approvals = data.objects("approvals").map { it.approval() },
                                    takeoverSessionIds = data.objects("takeovers").map { it.string("sessionId") }.toSet(),
                                ),
                            )
                        }
                        "session.upserted" -> emit(GlobalEvent.Upserted(frame.payload().obj("session").session()))
                        "session.removed" -> emit(GlobalEvent.Removed(frame.payload().string("sessionId")))
                        "approval.upserted" -> emit(GlobalEvent.ApprovalUpserted(frame.payload().obj("approval").approval()))
                        "takeover.upserted" -> frame.payload().obj("takeover").let {
                            emit(GlobalEvent.TakeoverUpserted(it.string("id"), it.string("sessionId"), it.string("status") in setOf("pending", "active")))
                        }
                        "agent.upserted" -> emit(GlobalEvent.AgentUpdated(frame.payload().obj("agent").chatAgent()))
                        "agent.removed" -> emit(GlobalEvent.AgentRemoved(frame.payload().string("agentId")))
                        "background.changed", "triggers.changed", "memory.changed" -> emit(GlobalEvent.Changed(frame.type))
                    }
                    if (frame.id != null) {
                        cursor = frame.id
                        backoff = 500L
                    }
                }
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(8_000)
        }
    }

    fun authenticatedRequest(
        path: List<String>,
        query: Map<String, String> = emptyMap(),
    ): Request.Builder {
        val url = base.newBuilder().apply {
            path.forEach { addPathSegment(it) }
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
        return Request.Builder().url(url).header("x-rei-client", "android/$PROTOCOL").apply {
            if (token != null) header("Authorization", "Bearer $token")
        }
    }

    fun websocket(
        path: List<String>,
        listener: WebSocketListener,
        query: Map<String, String> = emptyMap(),
    ): WebSocket = http.newWebSocket(authenticatedRequest(path, query).build(), listener)

    suspend fun request(
        method: String,
        path: List<String>,
        body: JsonObject? = null,
        query: Map<String, String> = emptyMap(),
    ): JsonObject {
        val payload = body ?: if (method in bodyMethods) JsonObject(emptyMap()) else null
        val request = authenticatedRequest(path, query)
            .header("Accept", "application/json")
            .method(method, payload?.toString()?.toRequestBody(jsonMediaType))
            .build()
        return execute(request)
    }

    private suspend fun execute(request: Request): JsonObject =
        suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(e as? ReiApiException ?: networkError())
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            if (!it.isSuccessful) throw it.apiError(it.body?.string())
                            val text = it.body?.string().orEmpty()
                            if (text.isEmpty() || text.trim() == "null") JsonObject(emptyMap()) else parse(text)
                        }
                    }
                    continuation.resumeWith(result)
                }
            })
        }

    private fun frames(path: List<String>, cursor: String? = null): Flow<StreamFrame> = callbackFlow {
        val request = authenticatedRequest(path)
            .header("Accept", "text/event-stream")
            .apply { if (cursor != null) header("Last-Event-ID", cursor) }
            .build()
        val source = eventSources.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                if (type == null || type == "ping") return
                if (trySend(StreamFrame(type, id, data)).isFailure) {
                    eventSource.cancel()
                    close()
                }
            }

            override fun onClosed(eventSource: EventSource) {
                close()
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val failure = if (response != null && !response.isSuccessful) {
                    response.apiError(runCatching { response.body?.string() }.getOrNull())
                } else {
                    networkError()
                }
                close(failure)
            }
        })
        awaitClose { source.cancel() }
    }

    private suspend inline fun reconnectable(block: () -> Unit) {
        try {
            block()
        } catch (failure: ReiApiException) {
            if (failure.status !in retryable) throw failure
        }
    }

    private data class StreamFrame(val type: String, val id: String?, val data: String) {
        fun payload() = parse(data)
    }

    internal companion object {
        const val PROTOCOL = 1
        val jsonMediaType = "application/json".toMediaType()
        val bodyMethods = setOf("POST", "PUT", "PATCH")
        val retryable = setOf(0, 502, 503, 504)
        val sessionEventTypes = setOf("snapshot", "patch", "resync_required", "session.removed")

        val http = OkHttpClient.Builder()
            .followRedirects(false)
            .readTimeout(45, TimeUnit.SECONDS)
            .build()
        val sseHttp = http.newBuilder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build()
        val eventSources = EventSources.createFactory(sseHttp)

        @OptIn(ExperimentalCoroutinesApi::class)
        internal suspend fun <T> OkHttpClient.executeStreaming(
            request: Request,
            dispatcher: CoroutineDispatcher = Dispatchers.IO,
            block: (Response) -> T,
        ): T = withContext(dispatcher) {
            val call = newCall(request)
            val response = suspendCancellableCoroutine { continuation ->
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        if (!continuation.isActive) {
                            response.close()
                            return
                        }
                        continuation.resume(response) { _, value, _ -> value.close() }
                    }
                })
            }
            val cancelHandle = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
                if (cause != null) call.cancel()
            }
            try {
                response.use(block)
            } finally {
                cancelHandle?.dispose()
            }
        }

        fun sessionPath(id: String): List<String> = listOf("api", "sessions", id)

        fun parse(raw: String): JsonObject = try {
            Json.parseToJsonElement(raw).jsonObject
        } catch (_: IllegalArgumentException) {
            throw ReiApiException(0, "invalid_response", "The server returned an invalid response.")
        }

        fun JsonObject.signInToken(): String = optionalString("token")?.takeIf { it.isNotEmpty() }
            ?: throw ReiApiException(0, "no_token", "Rei did not return a credential for this device.")

        fun networkError() = ReiApiException(0, "network_error", "Could not reach the Rei server.")

        fun Response.apiError(raw: String?): ReiApiException {
            val error = raw?.let { runCatching { parse(it)["error"] as? JsonObject }.getOrNull() }
            return ReiApiException(
                code,
                error?.optionalString("code") ?: "http_error",
                if (code == 426) "Update the Rei Android app to connect to this server."
                else error?.optionalString("message") ?: "Rei returned HTTP $code.",
            )
        }
    }
}
