package dev.rei.android.feature.connect

import dev.rei.android.R
import dev.rei.android.ui.UiText
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Checks a typed server address before it is sent anywhere, with the plain-language message to show under the field. */
object ServerAddress {
    private val localHosts = setOf("localhost", "127.0.0.1", "::1", "[::1]")

    /**
     * Returns null for an address that can be tried, or the message to show. A blank address is not an error (the Connect
     * button is simply off). Release builds only connect over HTTPS; [allowCleartext] (debug builds) also accepts http
     * for the local machine, the way `ReiApi` does.
     */
    fun validate(raw: String, allowCleartext: Boolean): UiText? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (text.any(Char::isWhitespace)) return UiText.Resource(R.string.connect_err_spaces)
        if (!text.contains("://")) return UiText.Resource(R.string.connect_err_scheme_example)
        val url = text.toHttpUrlOrNull()
            ?: return UiText.Resource(
                if (text.startsWith("http://") || text.startsWith("https://")) R.string.connect_err_invalid
                else R.string.connect_err_use_https,
            )
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return UiText.Resource(R.string.connect_err_credentials)
        if (url.query != null || url.fragment != null || url.encodedPath != "/") return UiText.Resource(R.string.connect_err_path)
        if (!url.isHttps) {
            val local = url.host in localHosts
            if (!(allowCleartext && local)) return UiText.Resource(R.string.connect_err_https_only)
        }
        return null
    }

    /** Prepends `https://` when the user omits a URL scheme so plain hostnames work on Connect. */
    fun normalize(raw: String): String {
        val text = raw.trim()
        if (text.isEmpty() || text.contains("://") || text.any(Char::isWhitespace)) return text
        return "https://$text"
    }

    /** A gentle nudge while typing, before there is anything wrong: shown for a release build and an http address. */
    fun hint(raw: String, allowCleartext: Boolean): UiText? {
        val text = raw.trim()
        return if (!allowCleartext && text.startsWith("http://")) UiText.Resource(R.string.connect_err_https_only) else null
    }
}
