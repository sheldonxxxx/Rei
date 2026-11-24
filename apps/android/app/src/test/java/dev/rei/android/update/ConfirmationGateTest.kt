package dev.rei.android.update

import dev.rei.android.update.ConfirmationGate.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfirmationGateTest {
    private val launched = mutableListOf<String>()
    private var fail = false
    private val gate = ConfirmationGate<String> {
        if (fail) error("blocked")
        launched += it
    }

    @Test
    fun launchesAtOnceWhileInTheForeground() {
        gate.onForeground()
        assertEquals(Outcome.Launched, gate.offer("confirm"))
        assertEquals(listOf("confirm"), launched)
        assertFalse(gate.hasPending)
    }

    @Test
    fun keepsTheConfirmationUntilTheAppReturns() {
        assertEquals(Outcome.Deferred, gate.offer("confirm"))
        assertTrue(launched.isEmpty())
        assertTrue(gate.hasPending)
        assertEquals(Outcome.Launched, gate.onForeground())
        assertEquals(listOf("confirm"), launched)
        assertNull(gate.onForeground())
        assertEquals(1, launched.size)
    }

    @Test
    fun backgroundingAgainDefersTheNextConfirmation() {
        gate.onForeground()
        gate.onBackground()
        assertEquals(Outcome.Deferred, gate.offer("later"))
        assertTrue(launched.isEmpty())
    }

    @Test
    fun aFailedLaunchIsReportedAndNotRetried() {
        gate.onForeground()
        fail = true
        assertEquals(Outcome.Blocked, gate.offer("confirm"))
        assertFalse(gate.hasPending)
    }

    @Test
    fun clearingDropsAStaleConfirmation() {
        gate.offer("old")
        gate.clear()
        assertNull(gate.onForeground())
        assertTrue(launched.isEmpty())
    }

    @Test
    fun theNewestConfirmationReplacesAnOlderOne() {
        gate.offer("first")
        gate.offer("second")
        gate.onForeground()
        assertEquals(listOf("second"), launched)
    }
}
