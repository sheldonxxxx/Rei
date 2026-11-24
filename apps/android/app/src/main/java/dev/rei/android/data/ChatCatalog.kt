package dev.rei.android.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class ChatAgent(
    val id: String,
    val name: String,
    val homeSessionId: String,
    val avatar: String = "",
    /** The chosen model id, or null for the server default. */
    val model: String? = null,
    /** `off` keeps the provider's default behavior. */
    val thinkingLevel: String = "off",
)

data class HistoryHit(
    val id: String,
    val sessionId: String,
    val title: String,
    val messageId: String,
    val snippet: String,
)

internal fun JsonObject.chatAgent() =
    ChatAgent(
        string("id"), string("name"), string("homeSessionId"), optionalString("avatar").orEmpty(),
        optionalString("model"), optionalString("thinkingLevel") ?: "off",
    )

internal suspend fun ReiApi.searchHistory(query: String, agentId: String?): List<HistoryHit> {
    val filter = buildMap {
        put("q", query)
        if (agentId != null) put("agent", agentId)
    }
    return request("GET", listOf("api", "history", "search"), query = filter).objects("hits").map {
        HistoryHit(
            id = it.string("chunkId"),
            sessionId = it.string("sessionId"),
            title = it.string("sessionTitle"),
            messageId = it.string("messageId"),
            snippet = it.string("snippet"),
        )
    }
}

internal suspend fun ReiApi.updateChat(id: String, title: String? = null, pinned: Boolean? = null): Session =
    request("PATCH", listOf("api", "sessions", id), buildJsonObject {
        if (title != null) put("title", title)
        if (pinned != null) put("pinned", pinned)
    }).obj("session").session()

internal suspend fun ReiApi.deleteChat(id: String, deleteForks: Boolean = false) {
    val query = if (deleteForks) mapOf("withForks" to "1") else emptyMap()
    request("DELETE", listOf("api", "sessions", id), query = query)
}
