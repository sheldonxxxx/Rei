package dev.rei.android.data

import androidx.annotation.StringRes
import dev.rei.android.R
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * How freely a chat's agent may act. Strict, Standard (the default) and YOLO are the levels you can choose in a chat;
 * the legacy `relaxed` and anything missing or unknown read as Standard, as in the web app. The labels and descriptions
 * are the web's (`PROFILE_LABEL` and `PROFILE_HELP` in `policy.ts`).
 */
enum class ChatProfile(val wire: String, @StringRes val labelRes: Int, @StringRes val descriptionRes: Int) {
    Strict("strict", R.string.chat_profile_strict, R.string.chat_profile_strict_desc),
    Standard("standard", R.string.chat_profile_standard, R.string.chat_profile_standard_desc),
    Yolo("yolo", R.string.chat_profile_yolo, R.string.chat_profile_yolo_desc),
    ;

    companion object {
        /** The level to show for what the server sent: a missing value, `relaxed` or an unknown name is Standard. */
        fun fromWire(value: String?): ChatProfile = entries.firstOrNull { it.wire == value } ?: Standard
    }
}

/** `PATCH /api/sessions/:id` with `{ profile }`, as the web's `updateSession`; answers the updated session. */
internal suspend fun ReiApi.updateSessionProfile(id: String, profile: ChatProfile): Session =
    request("PATCH", listOf("api", "sessions", id), buildJsonObject { put("profile", profile.wire) }).obj("session").session()
