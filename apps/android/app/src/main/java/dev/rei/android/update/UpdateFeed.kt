package dev.rei.android.update

import dev.rei.android.R
import dev.rei.android.ui.UiText
import java.io.IOException
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * `android-update.json`, published next to each release APK. Fields the app does not know are ignored, so the feed can grow.
 * [sha256] is the lowercase or uppercase hex digest of the APK; [minSdk] is the lowest Android API level that can run it.
 */
@Serializable
data class UpdateFeed(
    val versionCode: Long,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val minSdk: Int = 0,
    val notes: String = "",
) {
    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Parses and checks a feed body; anything malformed becomes an [UpdateException] with a plain-language message. */
        fun parse(raw: String): UpdateFeed {
            val feed = try {
                json.decodeFromString(serializer(), raw)
            } catch (_: SerializationException) {
                throw UpdateException(UiText.Resource(R.string.update_err_feed_unreadable), "The update feed could not be read.")
            } catch (_: IllegalArgumentException) {
                throw UpdateException(UiText.Resource(R.string.update_err_feed_unreadable), "The update feed could not be read.")
            }
            if (feed.versionCode <= 0 || feed.versionName.isBlank() || feed.apkUrl.isBlank() || !feed.sha256.isSha256()) {
                throw UpdateException(UiText.Resource(R.string.update_err_feed_incomplete), "The update feed is incomplete.")
            }
            return feed
        }

        private fun String.isSha256() = length == 64 && all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
    }
}

/** Why an update check or download failed, in words a person can read. */
class UpdateException(val uiText: UiText, message: String) : IOException(message) {
    constructor(message: String) : this(UiText.Literal(message), message)
}
