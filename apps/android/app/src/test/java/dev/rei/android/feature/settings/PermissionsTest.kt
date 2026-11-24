package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PermissionsTest {
    private fun grant(length: String, destination: String? = null, connector: String = "web", operation: String = "fetch") =
        GrantItem("g", connector, operation, destination, length, "s1", "a1", null, null)

    @Test fun grantLengthsReadInWords() {
        assertEquals(UiText.Resource(R.string.settings_perm_always), describeGrant(grant("always"), null, null))
        assertEquals(UiText.Resource(R.string.settings_perm_session_named, "Trip"), describeGrant(grant("session"), "Trip", null))
        assertEquals(UiText.Resource(R.string.settings_perm_session_anon), describeGrant(grant("session"), null, null))
        assertEquals(UiText.Resource(R.string.settings_perm_web_session_named, "Trip"), describeGrant(grant("web_session"), "Trip", null))
        assertEquals(UiText.Resource(R.string.settings_perm_agent_named, "Dot"), describeGrant(grant("agent"), null, "Dot"))
        assertEquals(UiText.Resource(R.string.settings_perm_agent_anon), describeGrant(grant("agent"), null, null))
        assertEquals(UiText.Resource(R.string.settings_perm_set_time), describeGrant(grant("hours"), null, null))
    }

    @Test fun connectorToolDestinationsNameTheApp() {
        assertEquals(UiText.Literal("Mail") to "send", mcpTarget("c1.send", mapOf("c1" to "Mail")))
        assertEquals(UiText.Resource(R.string.settings_perm_connected_app) to "send", mcpTarget("zz.send", mapOf("c1" to "Mail")))
        assertNull(mcpTarget(null, emptyMap()))
        assertNull(mcpTarget("nodot", emptyMap()))
        assertNull(mcpTarget(".lead", emptyMap()))
    }

    @Test fun grantNamesPreferTheConnectorTool() {
        assertEquals(UiText.Resource(R.string.settings_perm_pair, UiText.Literal("Mail"), "send"), grantName(grant("always", "c1.send", connector = "mcp"), mapOf("c1" to "Mail")))
        assertEquals(UiText.Resource(R.string.settings_perm_pair, "web", "fetch"), grantName(grant("always", "example.com"), emptyMap()))
    }

    @Test fun parsesAGrantFromTheServer() {
        val item = Json.parseToJsonElement(
            """{"id":"g1","connector":"mcp","operation":"call","destination":null,"length":"hours","sessionId":null,"agentId":null,"expiresAt":1000,"approvalId":"p","createdAt":5}""",
        ).jsonObject.grant()
        assertEquals(GrantItem("g1", "mcp", "call", null, "hours", null, null, 1000L, 5L), item)
    }
}
