package dev.rei.android.feature.settings

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

class SkillsTest {
    private val agents = listOf(AgentOption("a", "Rei"), AgentOption("b", "Scout"))

    @Test fun `frontmatter splits into fields and body`() {
        val parts = splitSkillMd("---\nname: weekly\ndescription: \"Plan the week\"\nallowed-tools: read\n  write\n---\n\n# Steps\n")
        assertEquals(listOf("name" to "weekly", "description" to "Plan the week", "allowed-tools" to "read write"), parts.fields)
        assertEquals("\n# Steps\n", parts.body)
        assertEquals(SkillMd(emptyList(), "just text"), splitSkillMd("just text"))
    }

    @Test fun `a new skill md quotes the description`() {
        val md = newSkillMd("weekly-review", "Say \"hi\": then go", "  Do it.  ")
        assertEquals("---\nname: weekly-review\ndescription: \"Say \\\"hi\\\": then go\"\n---\n\nDo it.\n", md)
        assertEquals("Say \"hi\": then go", splitSkillMd(md).fields[1].second.replace("\\\"", "\""))
    }

    @Test fun `skill names follow the server's rule`() {
        assertTrue(isSkillName("a"))
        assertTrue(isSkillName("weekly-review-2"))
        assertFalse(isSkillName("Weekly"))
        assertFalse(isSkillName("double--hyphen"))
        assertFalse(isSkillName("-lead"))
        assertFalse(isSkillName(""))
        assertTrue(newSkillReady("a", "d", "b"))
        assertFalse(newSkillReady("a", " ", "b"))
    }

    @Test fun `editing replaces SKILL md and keeps the other files`() {
        val files = listOf(SkillFile("SKILL.md", "text", "old"), SkillFile("scripts/x.py", "base64", "AAA="))
        val body = editBody(files, "new")
        val sent = body["files"]!!.jsonArray.map { it.jsonObject }
        assertEquals("new", sent[0]["content"]?.jsonPrimitive?.content)
        assertEquals("base64", sent[1]["encoding"]?.jsonPrimitive?.content)
        assertEquals("""{"restore":3}""", restoreBody(3).toString())
    }

    @Test fun `an import is a zip or a one file skill`() {
        val zip = importBody("pack.ZIP", null, byteArrayOf(1, 2, 3))
        assertEquals(Base64.getEncoder().encodeToString(byteArrayOf(1, 2, 3)), zip["zip"]?.jsonPrimitive?.content)
        assertEquals(zip.keys, setOf("zip"))
        assertEquals(setOf("zip"), importBody("x", "application/zip", byteArrayOf(1)).keys)
        val md = importBody("SKILL.md", "text/markdown", "# hi".toByteArray())
        assertEquals("# hi", md["files"]!!.jsonArray[0].jsonObject["content"]?.jsonPrimitive?.content)
    }

    @Test fun `agents read and save as the web does`() {
        assertEquals("All agents", agentsLine(null, agents))
        assertEquals("Scout", agentsLine(listOf("b"), agents))
        assertEquals("All agents", agentsLine(listOf("a", "b"), agents))
        assertEquals("No agents", agentsLine(emptyList(), agents))
        assertEquals(JsonNull, agentsBody(false, setOf("a"), agents)["agents"])
        assertEquals(listOf("a", "b"), agentsBody(true, setOf("b", "a"), agents)["agents"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun `the allow-list is changed only when it differs`() {
        assertFalse(agentsChanged(null, false, setOf("a", "b")))
        assertTrue(agentsChanged(null, true, setOf("a", "b")))
        assertFalse(agentsChanged(listOf("a"), true, setOf("a")))
        assertTrue(agentsChanged(listOf("a"), true, setOf("a", "b")))
        assertTrue(agentsChanged(listOf("a"), false, setOf("a")))
    }

    @Test fun `a skill response reads into data`() {
        val body = buildJsonObject {
            put("skill", buildJsonObject {
                put("id", "s1"); put("name", "weekly"); put("description", "d"); put("version", 2)
                put("agents", JsonNull); put("author", "agent")
                put("plugin", buildJsonObject { put("id", "p"); put("name", "Docs"); put("enabled", true) })
            })
            put("version", 1)
            put("files", buildJsonArray {
                add(buildJsonObject { put("path", "SKILL.md"); put("encoding", "text"); put("content", "x") })
                add(buildJsonObject { put("path", "a.bin"); put("encoding", "base64"); put("content", "AA==") })
            })
            put("versions", buildJsonArray {
                add(buildJsonObject { put("version", 2); put("author", "agent"); put("note", "Saved from chat"); put("createdAt", 5) })
            })
        }
        val data = skillData(body)
        assertFalse(data.current)
        assertNull(data.skill.agents)
        assertEquals("Docs", data.skill.pluginName)
        assertEquals("x", data.skillMd?.content)
        assertEquals(listOf("a.bin"), data.others.map { it.path })
        assertFalse(data.others[0].isText)
        assertEquals("Saved from chat", data.versions[0].note)
    }
}
