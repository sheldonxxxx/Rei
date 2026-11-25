package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class PluginsTest {
    private fun pkg() = PluginPackage(
        "weekly", "Plan the week",
        listOf(PackageSkill("plan", listOf(SkillFile("SKILL.md", "text", "old"), SkillFile("a.bin", "base64", "AA==")))),
        listOf(PackageConnection("notes", "https://x.example/mcp", "oauth", listOf("plan"))),
    )

    @Test fun `a plugin says what it brings`() {
        fun row(skills: Long, connections: Long) = PluginRow("p", "n", "", 1, true, null, false, skills, connections)
        assertEquals(UiText.Resource(R.string.settings_plugins_kind_both), row(1, 1).kind)
        assertEquals(UiText.Resource(R.string.settings_page_skills), row(2, 0).kind)
        assertEquals(UiText.Resource(R.string.settings_page_connectors), row(0, 1).kind)
    }

    @Test fun `a package round trips through json`() {
        val json = pkg().toJson()
        assertEquals(1, json["formatVersion"]?.jsonPrimitive?.content?.toInt())
        assertEquals(pkg(), json.pluginPackage())
    }

    @Test fun `adding skills and connections names them in order`() {
        val added = emptyPackage().addSkill().addSkill().addConnection()
        assertEquals(listOf("skill-1", "skill-2"), added.skills.map { it.name })
        assertTrue(added.skills[0].skillMd.contains("name: skill-1"))
        assertEquals("connection-1", added.mcp[0].name)
        assertEquals("none", added.mcp[0].auth)
    }

    @Test fun `renaming and removing a skill keeps connections consistent`() {
        val renamed = pkg().renameSkill(0, "plan-week")
        assertEquals(listOf("plan-week"), renamed.mcp[0].skills)
        val removed = pkg().removeSkill(0)
        assertTrue(removed.skills.isEmpty())
        assertTrue(removed.mcp[0].skills.isEmpty())
        assertEquals(pkg(), pkg().removeSkill(5))
    }

    @Test fun `editing a skill keeps its other files`() {
        val edited = pkg().setSkillMd(0, "new")
        assertEquals("new", edited.skills[0].skillMd)
        assertEquals(listOf("SKILL.md", "a.bin"), edited.skills[0].files.map { it.path })
    }

    @Test fun `a connection reads skills first without duplicates`() {
        val c = PackageConnection("n", "u", "none", listOf("a"))
        assertEquals(listOf("a", "b"), c.withSkill("b", true).skills)
        assertEquals(listOf("a"), c.withSkill("a", true).skills)
        assertEquals(emptyList<String>(), c.withSkill("a", false).skills)
        assertEquals(emptyList<PackageConnection>(), pkg().removeConnection(0).mcp)
    }

    @Test fun `a package is checked before it is sent`() {
        assertNull(packageProblem(pkg()))
        assertEquals(UiText.Resource(R.string.settings_plugins_err_name), packageProblem(pkg().copy(name = " ")))
        assertEquals(UiText.Resource(R.string.settings_plugins_err_desc), packageProblem(pkg().copy(description = "")))
        assertEquals(UiText.Resource(R.string.settings_plugins_err_empty), packageProblem(emptyPackage().copy(name = "n", description = "d")))
        assertEquals(UiText.Resource(R.string.settings_plugins_err_conn_url), packageProblem(pkg().updateConnection(0) { it.copy(url = "") }))
    }

    @Test fun `saving sends the revision only for an update`() {
        assertEquals(7, savePluginBody(pkg(), 7)["expectedRevision"]?.jsonPrimitive?.content?.toInt())
        assertFalse(savePluginBody(pkg(), null).containsKey("expectedRevision"))
    }

    @Test fun `installation requests`() {
        assertEquals("""{"enabled":false}""", enabledBody(false).toString())
        assertEquals(JsonNull, allAgentsBody(true)["agents"])
        assertEquals(0, allAgentsBody(false)["agents"]!!.jsonArray.size)
        assertEquals(listOf("a", "b"), agentToggleBody(listOf("a"), "b", true)["agents"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("a"), agentToggleBody(listOf("a", "b"), "b", false)["agents"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun `an import is the zip in base64`() {
        assertEquals(Base64.getEncoder().encodeToString(byteArrayOf(9, 8)), pluginZipBody(byteArrayOf(9, 8))["zip"]?.jsonPrimitive?.content)
    }

    @Test fun `a plugin response reads into detail`() {
        val body = buildJsonObject {
            put("plugin", buildJsonObject {
                put("id", "p"); put("name", "weekly"); put("description", "d"); put("revision", 3); put("enabled", false)
                put("agents", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("a")) })
                put("selectedRevision", 2)
                put("package", pkg().toJson())
                put("revisions", buildJsonArray { add(buildJsonObject { put("revision", 3); put("author", "agent"); put("createdAt", 9) }) })
                put("connections", buildJsonArray { add(buildJsonObject { put("name", "notes"); put("connectorId", "c1"); put("status", "needs_auth") }) })
            })
        }
        val detail = pluginDetail(body)
        assertFalse(detail.row.enabled)
        assertEquals(listOf("a"), detail.row.agents)
        assertEquals(2, detail.selectedRevision)
        assertEquals("c1", detail.connections[0].connectorId)
        assertEquals(UiText.Resource(R.string.settings_conn_status_needs_auth), connectionStatusWord(detail.connections[0].status))
        assertEquals(UiText.Resource(R.string.settings_plugins_status_pending), connectionStatusWord(null))
        assertTrue(prettyPackage(detail.pkg).contains("\"formatVersion\": 1"))
    }
}
