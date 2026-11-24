package dev.rei.android.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class GeneralTest {
    @Test fun titleChoicesMapBothWays() {
        assertEquals(TitlesOff, titleSelection(false, "gpt-6"))
        assertEquals(TitlesDefault, titleSelection(true, null))
        assertEquals("gpt-6", titleSelection(true, "gpt-6"))
        assertEquals("""{"enabled":false}""", titleUpdate(TitlesOff).toString())
        assertEquals("""{"enabled":true,"model":null}""", titleUpdate(TitlesDefault).toString())
        assertEquals("""{"enabled":true,"model":"local/llama"}""", titleUpdate("local/llama").toString())
    }

    @Test fun timeZoneOptionsAlwaysIncludeTheDeviceSavedAndUtc() {
        val options = timeZoneOptions(listOf("Europe/Paris", "Asia/Tokyo"), "Pacific/Auckland", "Custom/Zone")
        assertEquals(listOf("Asia/Tokyo", "Custom/Zone", "Europe/Paris", "Pacific/Auckland", "UTC"), options)
        assertEquals(listOf("UTC"), timeZoneOptions(emptyList(), null, null))
    }

    @Test fun zoneSearchMatchesEveryWord() {
        val zones = listOf("America/New_York", "America/Los_Angeles", "Europe/Paris")
        assertEquals(zones, filterZones(zones, "  "))
        assertEquals(listOf("America/New_York"), filterZones(zones, "new york"))
        assertEquals(listOf("America/New_York", "America/Los_Angeles"), filterZones(zones, "AMERICA"))
        assertEquals(emptyList<String>(), filterZones(zones, "tokyo"))
    }

    @Test fun authenticatorCodesKeepSixDigits() {
        assertEquals("123456", totpDigits("123 456 789"))
        assertEquals("12", totpDigits("1a2"))
    }
}
