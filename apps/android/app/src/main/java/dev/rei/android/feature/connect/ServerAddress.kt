package dev.rei.android.feature.connect

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Checks a typed server address before it is sent anywhere, with the plain-language message to show under the field. */
object ServerAddress {
    private val localHosts = setOf("localhost", "127.0.0.1", "::1", "[::1]")

    /**
     * Returns null for an address that can be tried, or the message to show. A blank address is not an error (the Connect
     * button is simply off). Release builds only connect over HTTPS; [allowCleartext] (debug builds) also accepts http
     * for the local machine, the way `ReiApi` does.
     */
    fun validate(raw: String, allowCleartext: Boolean): String? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (text.any(Char::isWhitespace)) return "The address can’t contain spaces."
        if (!text.contains("://")) return "Start with https://, for example https://rei.example.com."
        val url = text.toHttpUrlOrNull()
            ?: return if (text.startsWith("http://") || text.startsWith("https://")) "That isn’t a valid address." else "Use an https:// address."
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) return "Leave the username and password out of the address."
        if (url.query != null || url.fragment != null || url.encodedPath != "/") return "Use only the server address, without a path."
        if (!url.isHttps) {
            val local = url.host in localHosts
            if (!(allowCleartext && local)) return "Use https:// — Rei only connects to a server over HTTPS."
        }
        return null
    }

    /** A gentle nudge while typing, before there is anything wrong: shown for a release build and an http address. */
    fun hint(raw: String, allowCleartext: Boolean): String? {
        val text = raw.trim()
        return if (!allowCleartext && text.startsWith("http://")) "Use https:// — Rei only connects to a server over HTTPS." else null
    }
}
