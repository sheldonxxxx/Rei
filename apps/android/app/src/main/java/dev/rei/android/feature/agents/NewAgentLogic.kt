package dev.rei.android.feature.agents

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Matches the server's agent name limit, in UTF-16 units. */
internal const val AgentNameMax = 40

/** The request is ready once the user names the agent and picks a look. */
internal fun createAgentBody(name: String, avatar: String): JsonObject? {
    val trimmedName = name.trim()
    val trimmedAvatar = avatar.trim()
    if (trimmedName.isEmpty() || trimmedName.length > AgentNameMax || trimmedAvatar.isEmpty()) return null
    return buildJsonObject {
        put("name", trimmedName)
        put("avatar", trimmedAvatar)
    }
}
