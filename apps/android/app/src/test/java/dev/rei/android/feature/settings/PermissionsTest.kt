package dev.rei.android.feature.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PermissionsTest {
    private fun grant(length: String, destination: String? = null, connector: String = "web", operation: String = "fetch") =
        GrantItem("g", connector, operation, destination, length, "s1", "a1", null, null)

    @Test fun grantLengthsReadInWords() {
        assertEquals("Always", describeGrant(grant("always"), null, null))
        assertEquals("For the chat “Trip”", describeGrant(grant("session"), "Trip", null))
        assertEquals("For one chat", describeGrant(grant("session"), null, null))
        assertEquals("All web in “Trip”", describeGrant(grant("web_session"), "Trip", null))
        assertEquals("For the agent Dot", describeGrant(grant("agent"), null, "Dot"))
        assertEquals("For one agent", describeGrant(grant("agent"), null, null))
        assertEquals("For a set time", describeGrant(grant("hours"), null, null))
    }

    @Test fun connectorToolDestinationsNameTheApp() {
        assertEquals("Mail" to "send", mcpTarget("c1.send", mapOf("c1" to "Mail")))
        assertEquals("A connected app" to "send", mcpTarget("zz.send", mapOf("c1" to "Mail")))
        assertNull(mcpTarget(null, emptyMap()))
        assertNull(mcpTarget("nodot", emptyMap()))
        assertNull(mcpTarget(".lead", emptyMap()))
    }

    @Test fun grantNamesPreferTheConnectorTool() {
        assertEquals("Mail · send", grantName(grant("always", "c1.send", connector = "mcp"), mapOf("c1" to "Mail")))
        assertEquals("web · fetch", grantName(grant("always", "example.com"), emptyMap()))
    }

    @Test fun parsesAGrantFromTheServer() {
        val item = Json.parseToJsonElement(
            """{"id":"g1","connector":"mcp","operation":"call","destination":null,"length":"hours","sessionId":null,"agentId":null,"expiresAt":1000,"approvalId":"p","createdAt":5}""",
        ).jsonObject.grant()
        assertEquals(GrantItem("g1", "mcp", "call", null, "hours", null, null, 1000L, 5L), item)
    }
}
