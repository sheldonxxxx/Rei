package dev.rei.android.feature.connect

import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull

class ServerAddressTest {
    @Test
    fun blankIsNotAnError() = assertNull(ServerAddress.validate("   ", allowCleartext = false))

    @Test
    fun httpsAddressIsAccepted() {
        assertNull(ServerAddress.validate("https://rei.example.com", allowCleartext = false))
        assertNull(ServerAddress.validate(" https://rei.example.com:8443 ", allowCleartext = false))
    }

    @Test
    fun missingSchemeAsksForHttps() {
        assertNotNull(ServerAddress.validate("rei.example.com", allowCleartext = false))
    }

    @Test
    fun releaseRefusesHttpEvenForLocalhost() {
        assertNotNull(ServerAddress.validate("http://127.0.0.1:8787", allowCleartext = false))
        assertNotNull(ServerAddress.validate("http://rei.example.com", allowCleartext = false))
    }

    @Test
    fun debugAllowsHttpOnlyForTheLocalMachine() {
        assertNull(ServerAddress.validate("http://127.0.0.1:8787", allowCleartext = true))
        assertNull(ServerAddress.validate("http://localhost:8787", allowCleartext = true))
        assertNotNull(ServerAddress.validate("http://rei.example.com", allowCleartext = true))
    }

    @Test
    fun pathsAndCredentialsAreRefused() {
        assertNotNull(ServerAddress.validate("https://rei.example.com/app", allowCleartext = false))
        assertNotNull(ServerAddress.validate("https://" + "me" + ":" + "pw" + "@rei.example.com", allowCleartext = false))
        assertNotNull(ServerAddress.validate("https://rei.example.com?x=1", allowCleartext = false))
    }

    @Test
    fun spacesAreRefused() = assertNotNull(ServerAddress.validate("https://rei example.com", allowCleartext = false))

    @Test
    fun hintAppearsForCleartextInRelease() {
        assertNotNull(ServerAddress.hint("http://rei.example.com", allowCleartext = false))
        assertNull(ServerAddress.hint("http://127.0.0.1", allowCleartext = true))
        assertEquals(null, ServerAddress.hint("https://rei.example.com", allowCleartext = false))
    }

    @Test
    fun normalizePrependsHttpsWhenSchemeOmitted() {
        assertEquals("https://rei.example.com", ServerAddress.normalize("rei.example.com"))
        assertEquals("http://localhost:8787", ServerAddress.normalize(" http://localhost:8787 "))
        assertEquals("", ServerAddress.normalize("   "))
    }
}
