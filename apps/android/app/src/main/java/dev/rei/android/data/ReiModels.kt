package dev.rei.android.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

data class Health(val protocolVersion: Int, val minClientProtocol: Int)

data class AuthState(
    val setupRequired: Boolean,
    val signedIn: Boolean,
    val totpEnabled: Boolean,
    val passkeys: Boolean = false,
)

data class Session(
    val id: String,
    val agentId: String,
    val title: String,
    val preview: String,
    val origin: String,
    val status: String,
    val unread: Int,
    val pinned: Boolean = false,
    val parentId: String? = null,
    val updatedAt: Long = 0,
    /** Approvals waiting in this session. */
    val pendingApprovals: Int = 0,
    val triggerId: String? = null,
    val hideInList: Boolean = false,
    /** The session has a browser window. */
    val hasBrowser: Boolean = false,
    /** The agent asked the user to take over that window. */
    val takeoverPending: Boolean = false,
    /** The chat's permission level; a missing or legacy `relaxed` value reads as Standard. */
    val profile: ChatProfile = ChatProfile.Standard,
)

data class Message(
    val id: String,
    val role: String,
    val text: String,
    val status: String,
    val requestId: String? = null,
    val createdAt: Long = 0,
    val attachments: List<String> = emptyList(),
    val approval: ReiApproval? = null,
    val parts: List<MessagePart> = emptyList(),
    val forkable: Boolean = false,
    val editable: Boolean = false,
    val fileReferences: List<AttachmentRef> = emptyList(),
    val runId: String? = null,
    /** Which version of an edited user message this is (1-based), when it has more than one. */
    val versions: MessageVersions? = null,
    /** The plain-language reason a reply failed, from the server. */
    val error: String? = null,
    /** An internal message the chat never shows. */
    val internal: Boolean = false,
    val takeover: TakeoverInfo? = null,
)

data class MessageVersions(val index: Int, val count: Int)

data class TakeoverInfo(val id: String, val status: String, val reason: String?, val title: String?, val url: String?)

sealed interface MessagePart {
    data class Text(val text: String) : MessagePart
    data class Surface(val value: JsonObject) : MessagePart
}

data class AttachmentRef(
    val fileId: String,
    val versionId: String,
    val name: String,
    val size: Long,
) {
    fun toJson() = buildJsonObject {
        put("fileId", fileId)
        put("versionId", versionId)
        put("name", name)
        put("size", size)
    }

    companion object {
        const val MaxCount = 10
        const val MaxTotalBytes = 2L * 1024 * 1024 * 1024

        fun fromJson(value: JsonObject): AttachmentRef = AttachmentRef(
            fileId = value.string("fileId"),
            versionId = value.string("versionId"),
            name = value.string("name"),
            size = value.getValue("size").jsonPrimitive.long,
        )
    }
}

data class LibraryPage(val files: List<AttachmentRef>, val nextCursor: String?)

data class ReiApproval(
    val id: String,
    val number: Int,
    val sessionId: String,
    val sessionTitle: String,
    val tool: String,
    val connector: String,
    val operation: String,
    val actionClass: String,
    val destination: String?,
    val summary: String,
    val argsPreview: String,
    val lengths: List<String>,
    val status: String,
    val taint: List<String>,
    val expiresAt: Long,
    val grantLength: String?,
    val grantExpiresAt: Long?,
    val resumesTool: Boolean,
    val execution: String?,
    /** The agent that asked. */
    val agentId: String = "",
    /** Reads requested in the same tool round can be decided together. */
    val groupId: String? = null,
    val createdAt: Long = 0,
    val decidedAt: Long? = null,
)

data class SessionsPage(val sessions: List<Session>, val nextCursor: String?)

data class TranscriptPage(val items: List<Message>, val before: String?)

data class SessionDetail(
    val session: Session,
    val messages: List<Message>,
    val before: String?,
    val busy: Boolean,
    val generation: String? = null,
)

sealed interface SessionEvent {
    data class Updated(val detail: SessionDetail) : SessionEvent
    data object Removed : SessionEvent
}

sealed interface GlobalEvent {
    data class Snapshot(
        val sessions: List<Session>,
        val defaultAgentId: String,
        val homeSessionId: String,
        val agents: List<ChatAgent> = emptyList(),
        /** Pending approvals in every session, oldest first. */
        val approvals: List<ReiApproval> = emptyList(),
        /** Sessions with a browser takeover waiting for the user. */
        val takeoverSessionIds: Set<String> = emptySet(),
    ) : GlobalEvent

    /** An approval was created or changed; once it is no longer pending it leaves the waiting list. */
    data class ApprovalUpserted(val approval: ReiApproval) : GlobalEvent

    /** A takeover was created or changed; [open] while it is pending or active. */
    data class TakeoverUpserted(val id: String, val sessionId: String, val open: Boolean) : GlobalEvent

    /**
     * A change notice with no payload: `background.changed`, `triggers.changed`, `memory.changed`. Pages that show those
     * things fetch again. Also sent as `snapshot` (an initial or reconnect snapshot) by the view model, for the same reason.
     */
    data class Changed(val type: String) : GlobalEvent

    data class Upserted(val session: Session) : GlobalEvent
    data class Removed(val id: String) : GlobalEvent
    data class AgentUpdated(val agent: ChatAgent) : GlobalEvent
    data class AgentRemoved(val id: String) : GlobalEvent
}

internal fun JsonObject.obj(key: String) = getValue(key).jsonObject
internal fun JsonObject.array(key: String) = this[key] as? JsonArray
internal fun JsonObject.objects(key: String) = array(key).orEmpty().map { it.jsonObject }
internal fun JsonObject.string(key: String) = getValue(key).jsonPrimitive.content
internal fun JsonObject.optionalString(key: String) =
    this[key]?.takeUnless { it == JsonNull }?.jsonPrimitive?.content

internal fun JsonObject.session() = Session(
    id = string("id"),
    agentId = string("agentId"),
    title = string("title"),
    preview = string("preview"),
    origin = string("origin"),
    status = string("status"),
    unread = getValue("unread").jsonPrimitive.int,
    pinned = this["pinned"]?.jsonPrimitive?.boolean == true,
    parentId = (get("forkedFrom") as? JsonObject)?.optionalString("sessionId") ?: optionalString("parentSessionId"),
    updatedAt = this["updatedAt"]?.jsonPrimitive?.long ?: 0,
    pendingApprovals = this["pendingApprovals"]?.jsonPrimitive?.int ?: 0,
    triggerId = optionalString("triggerId"),
    hideInList = this["hideInList"]?.jsonPrimitive?.boolean == true,
    hasBrowser = (this["browser"] as? JsonObject) != null,
    takeoverPending = ((this["browser"] as? JsonObject)?.get("takeover") as? JsonObject)?.optionalString("status") == "pending",
    profile = ChatProfile.fromWire(optionalString("profile")),
)

internal fun JsonObject.message() = Message(
    id = string("id"),
    role = string("role"),
    text = string("text"),
    status = string("status"),
    requestId = optionalString("requestId"),
    createdAt = getValue("createdAt").jsonPrimitive.long,
    attachments = objects("attachments").map { it.string("name") },
    approval = (get("approval") as? JsonObject)?.approval(),
    parts = objects("parts").mapNotNull { part ->
        when (part.string("type")) {
            "text" -> MessagePart.Text(part.string("text"))
            "surface" -> MessagePart.Surface(part.obj("surface"))
            else -> null
        }
    },
    forkable = optionalString("forkable") == "true",
    editable = optionalString("editable") == "true",
    fileReferences = objects("attachments")
        .filter { it.optionalString("fileId") != null && it.optionalString("versionId") != null }
        .map(AttachmentRef::fromJson),
    runId = optionalString("runId"),
    versions = (get("versions") as? JsonObject)?.let { v ->
        val count = v["count"]?.jsonPrimitive?.int ?: 0
        if (count > 1) MessageVersions(v["index"]?.jsonPrimitive?.int ?: 1, count) else null
    },
    error = (get("error") as? JsonObject)?.optionalString("message"),
    internal = this["internal"]?.jsonPrimitive?.boolean == true,
    takeover = (get("takeover") as? JsonObject)?.let { t ->
        TakeoverInfo(t.string("id"), t.string("status"), t.optionalString("reason"), t.optionalString("title"), t.optionalString("url"))
    },
)

internal fun JsonObject.authState() = AuthState(
    setupRequired = getValue("setupRequired").jsonPrimitive.boolean,
    signedIn = getValue("signedIn").jsonPrimitive.boolean,
    totpEnabled = getValue("totpEnabled").jsonPrimitive.boolean,
    passkeys = this["passkeys"]?.jsonPrimitive?.boolean == true,
)

internal fun JsonObject.approval() = ReiApproval(
    id = string("id"),
    number = getValue("number").jsonPrimitive.int,
    sessionId = string("sessionId"),
    sessionTitle = string("sessionTitle"),
    tool = string("tool"),
    connector = string("connector"),
    operation = string("operation"),
    actionClass = string("actionClass"),
    destination = optionalString("destination"),
    summary = string("summary"),
    argsPreview = string("argsPreview"),
    lengths = array("lengths").orEmpty().map { it.jsonPrimitive.content },
    status = string("status"),
    taint = array("taint").orEmpty().map { it.jsonPrimitive.content },
    expiresAt = getValue("expiresAt").jsonPrimitive.long,
    grantLength = optionalString("grantLength"),
    grantExpiresAt = optionalString("grantExpiresAt")?.toLong(),
    resumesTool = this["resumesTool"]?.jsonPrimitive?.boolean == true,
    execution = optionalString("execution"),
    agentId = optionalString("agentId").orEmpty(),
    groupId = optionalString("groupId"),
    createdAt = this["createdAt"]?.jsonPrimitive?.long ?: 0,
    decidedAt = optionalString("decidedAt")?.toLongOrNull(),
)
