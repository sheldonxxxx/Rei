package dev.rei.android.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

class ApprovalLabelsTest {
    @Test
    fun decidedCardsUseTheWebWording() {
        assertEquals("Approved once", decidedGrantLabel("once"))
        assertEquals("Approved for this chat", decidedGrantLabel("session"))
        assertEquals("All web approved for this chat", decidedGrantLabel("web_session"))
        assertEquals("Approved for this agent", decidedGrantLabel("agent"))
        assertEquals("Always allowed", decidedGrantLabel("always"))
        assertEquals("Approved", decidedGrantLabel("unknown"))
    }
}
