package dev.rei.android.feature.settings

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectorsTest {
    private fun connector(
        auth: String = "oauth", header: String? = null, identity: String? = "id", revision: String? = "r1",
    ) = Connector("c1", "Notion", "https://mcp.notion.com/mcp", auth, header, "connected", null, 3, true, "always_ask", revision, identity, null, null, true)

    private fun tool(default: ToolClass, override: ToolClass? = null) = ConnectorTool("t", "", default, override, null, "fp")

    @Test fun `a name is guessed from the address`() {
        assertEquals("Notion", nameFromUrl("https://mcp.notion.com/mcp"))
        assertEquals("Example", nameFromUrl("example.com/mcp"))
        assertEquals("Localhost", nameFromUrl("http://localhost:8080/mcp"))
    }

    @Test fun `the catalog matches its own endpoint only`() {
        val notion = ConnectorCatalog.first { it.id == "notion" }
        assertTrue(matchesCatalogUrl("https://mcp.notion.com/mcp", notion))
        assertTrue(matchesCatalogUrl("https://mcp.notion.com/mcp/", notion))
        assertFalse(matchesCatalogUrl("https://mcp.notion.com/mcp?x=1", notion))
        assertFalse(matchesCatalogUrl("https://evil.example/mcp", notion))
    }

    @Test fun `a sign-in return carries state and code`() {
        val result = signInReturn("https://rei.example/settings/connectors?state=abc&code=x%2By&iss=https%3A%2F%2Fissuer")
        assertEquals(SignInReturn.Code("abc", "x+y", "https://issuer"), result)
        assertEquals("""{"state":"abc","code":"x+y","iss":"https://issuer"}""", finishBody(result as SignInReturn.Code).toString())
    }

    @Test fun `a sign-in return reports provider errors and missing codes`() {
        assertEquals(SignInReturn.Failed("access_denied"), signInReturn("https://rei.example/settings/connectors?oauth_error=access_denied"))
        assertEquals(SignInReturn.None, signInReturn("https://rei.example/settings/connectors"))
        assertEquals(SignInReturn.None, signInReturn("https://rei.example/?state=abc"))
        assertEquals(SignInReturn.None, signInReturn("not an address"))
    }

    @Test fun `choosing a tool's default class clears its override`() {
        val read = tool(ToolClass.Read)
        assertNull(overrideFor(read, ToolClass.Read))
        assertEquals(ToolClass.Write, overrideFor(read, ToolClass.Write))
        assertEquals(JsonNull, toolClassBody(read, null)["actionClass"])
        assertEquals("write_external", toolClassBody(read, ToolClass.Write)["actionClass"]?.jsonPrimitive?.content)
        assertEquals("fp", toolClassBody(read, null)["definitionFingerprint"]?.jsonPrimitive?.content)
    }

    @Test fun `an irreversible tool stays locked and irreversible`() {
        val danger = tool(ToolClass.Irreversible)
        assertTrue(danger.locked)
        assertEquals(ToolClass.Irreversible, danger.withOverride(ToolClass.Read).current)
        assertEquals(ToolClass.Write, tool(ToolClass.Read).withOverride(ToolClass.Write).current)
        assertEquals(ToolClass.Read, tool(ToolClass.Read, ToolClass.Write).withOverride(null).current)
    }

    @Test fun `the profile body carries identity and revision`() {
        val body = profileBody("read_only", connector(), confirmed = false)
        assertEquals("read_only", body["profile"]?.jsonPrimitive?.content)
        assertEquals("id", body["providerIdentity"]?.jsonPrimitive?.content)
        assertEquals("r1", body["expectedRevision"]?.jsonPrimitive?.content)
        assertFalse(body.containsKey("confirmYolo"))
        assertTrue(profileBody("yolo", connector(), confirmed = true).containsKey("confirmYolo"))
        assertFalse(connector(identity = null).canSetProfile())
        assertFalse(connector(revision = "").canSetProfile())
    }

    @Test fun `creating a connector trims, names and validates`() {
        val ready = connectorCreate(" https://x.example/mcp ", "", " tok ", "X-Key") as ConnectorCreate.Ready
        assertEquals("https://x.example/mcp", ready.body["url"]?.jsonPrimitive?.content)
        assertEquals("x.example", ready.body["name"]?.jsonPrimitive?.content)
        assertEquals("tok", ready.body["token"]?.jsonPrimitive?.content)
        assertEquals("X-Key", ready.body["tokenHeader"]?.jsonPrimitive?.content)
        val plain = connectorCreate("https://x.example/mcp", "Mine", "", "") as ConnectorCreate.Ready
        assertFalse(plain.body.containsKey("token"))
        assertTrue(connectorCreate("  ", "n", "", "") is ConnectorCreate.Invalid)
        assertTrue(connectorCreate("https://x.example/" + "a".repeat(2000), "n", "", "") is ConnectorCreate.Invalid)
    }

    @Test fun `authentication sends only what changed`() {
        val c = connector(auth = "token", header = "X-Key")
        assertNull(authenticationBody(c, "", "x-key"))
        assertEquals("""{"token":"new"}""", authenticationBody(c, " new ", "X-Key").toString())
        val cleared: JsonObject = authenticationBody(c, "", "")!!
        assertEquals(JsonNull, cleared["tokenHeader"])
        assertEquals(JsonPrimitive("Auth"), authenticationBody(c, "", "Auth")!!["tokenHeader"])
    }

    @Test fun `client details are sent only with a client id`() {
        assertEquals("{}", clientIdBody("", "secret").toString())
        assertEquals("""{"clientId":"id","clientSecret":"s"}""", clientIdBody(" id ", " s ").toString())
        assertEquals("""{"clientId":"id"}""", clientIdBody("id", "").toString())
    }

    @Test fun `tool counts and status read in words`() {
        assertEquals("Tools not listed yet", toolCountText(null))
        assertEquals("1 tool", toolCountText(1))
        assertEquals("4 tools", toolCountText(4))
        assertEquals("Needs sign-in", statusWord("needs_auth"))
        assertEquals("Error: boom", statusText(connector().copy(status = "error", error = "boom")))
    }

    @Test fun `a connector reads from the server's json`() {
        val json = buildJsonObject {
            put("id", "c1"); put("name", "Notion"); put("url", "https://mcp.notion.com/mcp"); put("status", "connected")
            put("plugin", buildJsonObject { put("id", "p1"); put("name", "Docs"); put("enabled", false) })
        }
        val parsed = json.connector()
        assertEquals("none", parsed.auth)
        assertEquals("Docs", parsed.pluginName)
        assertFalse(parsed.pluginEnabled)
        assertTrue(parsed.holdsPrivate)
    }
}
