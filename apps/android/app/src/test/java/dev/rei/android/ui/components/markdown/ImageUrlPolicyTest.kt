package dev.rei.android.ui.components.markdown

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Test

class ImageUrlPolicyTest {
    private fun allowed(url: String) = isPublicImageUrl(url.toHttpUrl())

    @Test
    fun publicHttpsImagesAreAllowed() {
        for (url in listOf(
            "https://example.com/a.png", "https://cdn.images.example.org:8443/a.png?x=1", "https://93.184.216.34/a.png",
            "https://172.15.0.1/a.png", "https://172.32.0.1/a.png", "https://100.63.0.1/a.png", "https://100.128.0.1/a.png",
            "https://[2606:4700:4700::1111]/a.png",
        )) assertEquals(url, true, allowed(url))
    }

    @Test
    fun plainHttpAndCredentialsAreRefused() {
        assertEquals(false, allowed("http://example.com/a.png"))
        val withCredentials = HttpUrl.Builder()
            .scheme("https")
            .username("user")
            .password("pass")
            .host("example.com")
            .addPathSegment("a.png")
            .build()
        assertEquals(false, isPublicImageUrl(withCredentials))
    }

    @Test
    fun loopbackPrivateAndLinkLocalIpv4LiteralsAreRefused() {
        for (host in listOf(
            "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "100.127.255.255", "0.0.0.0", "255.255.255.255",
        )) assertEquals(host, false, allowed("https://$host/a.png"))
    }

    @Test
    fun alternativeIpv4SpellingsAreCaughtBecauseTheUrlParserNormalisesThem() {
        for (host in listOf("2130706433", "0x7f.1", "017700000001", "127.1")) assertEquals(host, false, allowed("https://$host/a.png"))
    }

    @Test
    fun ipv6LoopbackUniqueLocalLinkLocalAndMappedAddressesAreRefused() {
        for (host in listOf("[::1]", "[::]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[febf::1]", "[::ffff:127.0.0.1]", "[::ffff:10.1.2.3]")) {
            assertEquals(host, false, allowed("https://$host/a.png"))
        }
    }

    @Test
    fun localNamesAreRefused() {
        for (host in listOf("localhost", "LOCALHOST", "printer.local", "api.internal", "app.localhost", "nas", "localhost.")) {
            assertEquals(host, false, allowed("https://$host/a.png"))
        }
    }
}
