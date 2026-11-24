package dev.rei.android.feature.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewAgentTest {
    @Test fun `a name and a look are required`() {
        assertNull(createAgentBody("  \n ", "bot:cat"))
        assertNull(createAgentBody("Tutor", "  "))
        assertNull(createAgentBody("x".repeat(AgentNameMax + 1), "bot:cat"))
    }

    @Test fun `the request carries the exact chosen name and look after trimming`() {
        assertEquals("""{"name":"News Reporter","avatar":"📰"}""", createAgentBody("  News Reporter ", " 📰 ").toString())
        assertEquals("""{"name":"Tutor","avatar":"bot:cat"}""", createAgentBody("Tutor", "bot:cat").toString())
    }
}
