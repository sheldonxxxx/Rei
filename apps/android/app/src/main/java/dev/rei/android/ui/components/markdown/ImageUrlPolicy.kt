package dev.rei.android.ui.components.markdown

import java.net.Inet4Address
import java.net.InetAddress
import okhttp3.HttpUrl

private val ipv4Literal = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")
// inet_aton-style spellings (0x7f.1, 017700000001, 2130706433): the system resolver reads them as addresses, so they are never names.
private val numericHost = Regex("""^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$""")
private val privateSuffixes = listOf(".local", ".localhost", ".internal")

/**
 * Whether a model-provided image URL may be fetched straight from this device. It must be a public-looking host: an IP
 * literal in a loopback, private, link-local, carrier-grade NAT or unspecified range, `localhost`, a `.local` or `.internal`
 * name, a numeric spelling of an address, or a name with no dot (a LAN short name) is refused, so an image link cannot probe the network the phone is on.
 *
 * This is a lightweight check on the address as written. It does not resolve DNS, so a public name that resolves to a
 * private address is not caught; redirects are never followed, which closes the other common route.
 */
internal fun isPublicImageUrl(url: HttpUrl): Boolean {
    if (!url.isHttps || url.username.isNotEmpty() || url.password.isNotEmpty()) return false
    val host = url.host.trimEnd('.').lowercase()
    if (host.isEmpty()) return false
    if (':' in host) return isPublicAddress(host)
    if (ipv4Literal.matches(host)) return isPublicAddress(host)
    if (numericHost.matches(host)) return false
    if (host == "localhost" || '.' !in host) return false
    return privateSuffixes.none { host.endsWith(it) }
}

/** [literal] is an IPv4 dotted quad or an IPv6 literal without brackets; a literal is parsed without any DNS lookup. */
private fun isPublicAddress(literal: String): Boolean {
    val address = runCatching { InetAddress.getByName(literal) }.getOrNull() ?: return false
    val b = address.address.map { it.toInt() and 0xFF }
    if (address is Inet4Address || b.size == 4) {
        return when {
            b[0] == 0 || b[0] == 10 || b[0] == 127 -> false
            b[0] == 100 && b[1] in 64..127 -> false
            b[0] == 169 && b[1] == 254 -> false
            b[0] == 172 && b[1] in 16..31 -> false
            b[0] == 192 && b[1] == 168 -> false
            b[0] >= 224 -> false
            else -> true
        }
    }
    return when {
        b.all { it == 0 } -> false
        b.dropLast(1).all { it == 0 } && b.last() == 1 -> false
        b[0] and 0xFE == 0xFC -> false
        b[0] == 0xFE && b[1] and 0xC0 == 0x80 -> false
        b[0] == 0xFF -> false
        else -> true
    }
}
