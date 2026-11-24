package dev.rei.android.feature.agents

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The longest description the server accepts for a new agent (`AGENT_DESCRIPTION_MAX_CHARS`). */
internal const val AgentDescriptionMax = 500

/** The description as sent: trimmed, or null when it is empty. */
internal fun agentDescription(text: String): String? = text.trim().takeIf { it.isNotEmpty() }

internal fun createAgentBody(description: String): JsonObject = buildJsonObject { put("description", description.trim()) }

/** The web's wording for a refused or failed create, by the server's error code; [fallback] is the server's own sentence. */
internal fun agentErrorMessage(code: String, fallback: String): String = when (code) {
    "not_found" -> "That agent no longer exists."
    "bad_request" -> "Describe the agent in 1 to $AgentDescriptionMax characters."
    "design_failed" -> "The model couldn't design the agent just now (it may be busy or over its limit). Nothing was created; try again in a moment."
    else -> fallback
}
