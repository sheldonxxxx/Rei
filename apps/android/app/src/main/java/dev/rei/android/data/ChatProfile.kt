package dev.rei.android.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * How freely a chat's agent may act. Strict, Standard (the default) and YOLO are the levels you can choose in a chat;
 * the legacy `relaxed` and anything missing or unknown read as Standard, as in the web app. The labels and descriptions
 * are the web's (`PROFILE_LABEL` and `PROFILE_HELP` in `policy.ts`).
 */
enum class ChatProfile(val wire: String, val label: String, val description: String) {
    Strict("strict", "Strict", "Asks before web research and actions outside the sandbox."),
    Standard(
        "standard", "Standard",
        "Researches, makes reversible edits, and updates memory automatically.",
    ),
    Yolo(
        "yolo", "YOLO",
        "Runs built-in actions automatically, including sends, trigger changes and irreversible actions. Logins still need you.",
    ),
    ;

    companion object {
        /** The level to show for what the server sent: a missing value, `relaxed` or an unknown name is Standard. */
        fun fromWire(value: String?): ChatProfile = entries.firstOrNull { it.wire == value } ?: Standard
    }
}

/** `PATCH /api/sessions/:id` with `{ profile }`, as the web's `updateSession`; answers the updated session. */
internal suspend fun ReiApi.updateSessionProfile(id: String, profile: ChatProfile): Session =
    request("PATCH", listOf("api", "sessions", id), buildJsonObject { put("profile", profile.wire) }).obj("session").session()
