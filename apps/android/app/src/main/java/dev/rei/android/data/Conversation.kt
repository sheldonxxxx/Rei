package dev.rei.android.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

private data class LiveState(val runId: String?, val generation: String?)

private fun JsonObject.liveState() = LiveState(
    runId = optionalString("runId"),
    generation = (get("generation") as? JsonObject)?.optionalString("text"),
)

internal data class Conversation(
    val session: Session,
    val items: List<Message>,
    val before: String?,
    val runs: List<String>,
    private val live: JsonObject?,
) {
    fun detail(): SessionDetail {
        val state = live?.liveState()
        return SessionDetail(
            session,
            items,
            before,
            busy = state?.runId != null || runs.any { it == "running" || it == "queued" } ||
                (runs.isEmpty() && session.status == "running"),
            generation = state?.generation,
        )
    }

    fun patch(frame: JsonObject): Conversation = copy(
        session = (frame["session"] as? JsonObject)?.session() ?: session,
        items = patchItems(frame),
        before = if (frame.containsKey("before")) frame.optionalString("before") else before,
        runs = if (frame.containsKey("runs")) frame.runStatuses() else runs,
        live = (frame["live"] as? JsonObject) ?: live,
    )

    private fun patchItems(frame: JsonObject): List<Message> {
        val remove = frame.array("remove").orEmpty().map { it.jsonPrimitive.content }.toSet()
        val upsert = frame.objects("upsert").map { it.message() }
        val order = frame.array("order")?.map { it.jsonPrimitive.content }
        if (remove.isEmpty() && upsert.isEmpty() && order == null) return items
        val byId = items.associateByTo(linkedMapOf()) { it.id }
        remove.forEach(byId::remove)
        upsert.forEach { byId[it.id] = it }
        return order?.mapNotNull(byId::get) ?: byId.values.toList()
    }
}

private fun JsonObject.runStatuses() = objects("runs").map { it.string("status") }

internal fun JsonObject.conversation(itemsField: String) = Conversation(
    session = obj("session").session(),
    items = objects(itemsField).map { it.message() },
    before = optionalString("before"),
    runs = runStatuses(),
    live = get("live") as? JsonObject,
)

internal class ConversationStream {
    private var epoch: String? = null
    private var revision: Long? = null
    private var conversation: Conversation? = null

    // A null update tells the connection to reconnect for a fresh snapshot.
    fun apply(type: String, frame: JsonObject): SessionEvent? {
        if (type == "session.removed") return SessionEvent.Removed
        if (type == "resync_required") return null

        val receivedEpoch = frame.string("epoch")
        val receivedRevision = frame.getValue("rev").jsonPrimitive.long
        val next = if (type == "snapshot") {
            frame.obj("view").conversation("items")
        } else {
            val previous = conversation ?: return null
            if (receivedEpoch != epoch || receivedRevision != revision?.plus(1L)) return null
            previous.patch(frame)
        }
        epoch = receivedEpoch
        revision = receivedRevision
        conversation = next
        return SessionEvent.Updated(next.detail())
    }
}
