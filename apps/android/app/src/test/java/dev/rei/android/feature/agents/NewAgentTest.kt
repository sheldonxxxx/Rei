package dev.rei.android.feature.agents

import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewAgentTest {
    @Test fun `an empty description is not sent`() {
        assertNull(agentDescription("  \n "))
        assertEquals("A social media manager", agentDescription("  A social media manager "))
    }

    @Test fun `the request carries the trimmed description`() {
        assertEquals("""{"description":"A tutor"}""", createAgentBody("  A tutor ").toString())
        assertEquals("A tutor", createAgentBody("A tutor")["description"]?.jsonPrimitive?.content)
    }

    @Test fun `errors read in the web's words`() {
        assertEquals("Describe the agent in 1 to 500 characters.", agentErrorMessage("bad_request", "x"))
        assertEquals("That agent no longer exists.", agentErrorMessage("not_found", "x"))
        assertEquals("server said", agentErrorMessage("other", "server said"))
        assertEquals(true, agentErrorMessage("design_failed", "x").startsWith("The model couldn't design"))
    }
}
