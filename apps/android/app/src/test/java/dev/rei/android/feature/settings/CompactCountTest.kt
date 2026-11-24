package dev.rei.android.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Test

/** The web writes counts with `Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })`; these pin its output. */
class CompactCountTest {
    @Test fun smallNumbersAreWrittenOut() {
        listOf(0L to "0", 1L to "1", 150L to "150", 600L to "600", 999L to "999").forEach { (n, text) -> assertEquals(text, compactCount(n)) }
    }

    @Test fun thousandsUseKWithOneDecimalAndNoTrailingZero() {
        listOf(
            1_000L to "1K", 1_049L to "1K", 1_050L to "1.1K", 1_150L to "1.2K", 1_200L to "1.2K",
            2_000L to "2K", 4_000L to "4K", 12_345L to "12.3K", 999_949L to "999.9K",
        ).forEach { (n, text) -> assertEquals("$n", text, compactCount(n)) }
    }

    @Test fun largerUnitsAndRollover() {
        listOf(
            999_950L to "1M", 1_000_000L to "1M", 1_500_000L to "1.5M", 12_340_000L to "12.3M", 999_950_000L to "1B",
            1_500_000_000L to "1.5B", 2_500_000_000_000L to "2.5T", 1_500_000_000_000_000L to "1500T",
        ).forEach { (n, text) -> assertEquals("$n", text, compactCount(n)) }
    }

    @Test fun negativesKeepTheirSign() {
        assertEquals("-5", compactCount(-5))
        assertEquals("-1.5K", compactCount(-1_500))
        assertEquals("-1M", compactCount(-999_950))
    }
}
