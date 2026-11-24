package dev.rei.android.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsLogicTest {
    @Test fun wholeNumbersAreStrict() {
        assertEquals(5L, parseWholeNumber(" 5 ", 1))
        assertNull(parseWholeNumber("", 1))
        assertNull(parseWholeNumber("1.5", 1))
        assertNull(parseWholeNumber("-3", 0))
        assertNull(parseWholeNumber("0", 1))
        assertEquals(0L, parseWholeNumber("0", 0))
        assertNull(parseWholeNumber("101", 2, 100))
        assertEquals(100L, parseWholeNumber("100", 2, 100))
        assertNull(parseWholeNumber("9".repeat(30), 1))
    }

    @Test fun rangeMessagesMatchTheWeb() {
        assertEquals("“Retries” must be a whole number from 0 to 10.", rangeMessage("Retries", 0, 10))
        assertEquals("“Room” must be a whole number, 1 or more.", rangeMessage("Room", 1, null))
        assertEquals("“T” must be a whole number from 1 to 7,200.", rangeMessage("T", 1, 7200))
    }

    @Test fun limitInputsClearSetOrRefuse() {
        assertEquals(LimitInput.Clear, parseLimit("  "))
        assertEquals(LimitInput.Value(128000), parseLimit("128000"))
        assertEquals(LimitInput.Invalid, parseLimit("0"))
        assertEquals(LimitInput.Invalid, parseLimit("12k"))
    }

    @Test fun limitSourcesReadInWords() {
        assertEquals("Set by you", limitSource("custom"))
        assertEquals("Reported by the provider", limitSource("detected"))
        assertEquals("Built-in default", limitSource("built_in"))
        assertEquals("Not reported. Enter a value if you know it.", limitSource("unknown"))
    }

    @Test fun onlyPrefixedModelsHaveAConnection() {
        assertEquals("local", connectionOf("local/llama"))
        assertNull(connectionOf("gpt-6"))
        assertNull(connectionOf("/odd"))
    }

    @Test fun whitelistEntriesAreTrimmedDedupedAndCapped() {
        assertEquals(AddEntry.Nothing, addWhitelistEntry(listOf("a.com"), "   "))
        assertEquals(AddEntry.Added(listOf("a.com", "pypi.org")), addWhitelistEntry(listOf("a.com"), " pypi.org "))
        assertEquals(AddEntry.Refused("“A.com” is already on the list."), addWhitelistEntry(listOf("a.com"), "A.com"))
        val full = List(MaxWhitelistEntries) { "h$it.example" }
        assertEquals(AddEntry.Refused("The list holds at most 200 entries."), addWhitelistEntry(full, "extra.example"))
    }

    @Test fun searchModelIdsFollowTheServersRule() {
        assertTrue(isSearchModelId("gpt-6-luna"))
        assertTrue(isSearchModelId("a.b_c-1"))
        assertFalse(isSearchModelId("has space"))
        assertFalse(isSearchModelId(""))
        assertFalse(isSearchModelId("x".repeat(101)))
    }

    @Test fun reorderingStaysInsideTheList() {
        assertEquals(listOf("b", "a", "c"), listOf("a", "b", "c").moved(0, 1))
        assertEquals(listOf("a", "b", "c"), listOf("a", "b", "c").moved(0, -1))
        assertEquals(listOf("a", "c", "b"), listOf("a", "b", "c").moved(2, -1))
    }
}
