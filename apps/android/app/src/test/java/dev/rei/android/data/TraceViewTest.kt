package dev.rei.android.data

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TraceViewTest {
    private fun json(value: String) = Json.parseToJsonElement(value)

    @Test
    fun requestSplitsPromptFromConversationAndKeepsLaterSystemMessagesAsUpdates() {
        val view = describeRequest(
            json(
                """{"messages":[
                    {"role":"system","content":"Be brief."},
                    {"role":"user","content":[{"type":"text","text":"Hi"}]},
                    {"role":"assistant","content":[{"type":"tool_use","name":"web_search","input":{"q":"x"}}]},
                    {"role":"system","content":"Updated system prompt section \"clock\":\n\n12:00"}
                ],"tools":[{"function":{"name":"read","description":"Read a file","parameters":{"type":"object"}}}]}""",
            ),
        )
        assertTrue(view.recognised)
        assertEquals("Be brief.", view.system)
        assertEquals(listOf("user", "assistant", "system"), view.messages.map { it.role })
        assertEquals(listOf("web_search({\"q\":\"x\"})"), view.messages[1].calls)
        assertTrue(view.messages[2].update)
        assertEquals("read", view.tools.single().name)
    }

    @Test
    fun responsesInputAndReasoningItemsAreRead() {
        val view = describeRequest(json("""{"instructions":"Sys","input":[{"type":"reasoning","summary":[{"text":"thinking"}]},{"role":"user","content":"Go"}]}"""))
        assertEquals("Sys", view.system)
        assertEquals("reasoning", view.messages.first().role)
        assertEquals("thinking", view.messages.first().text)
    }

    @Test
    fun responseGathersTextReasoningAndCalls() {
        val view = describeResponse(
            json("""{"output":[{"type":"reasoning","summary":[{"text":"plan"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]},{"type":"function_call","name":"bash","arguments":"{}"}]}"""),
        )
        assertEquals("Done", view.text)
        assertEquals("plan", view.reasoning)
        assertEquals(listOf("bash({})"), view.calls)
        assertFalse(describeResponse(json("""{"id":"x"}""")).recognised)
    }

    @Test
    fun sectionsSplitOnTagsOrHeadings() {
        val tagged = systemSections("Intro\n<memory>\nlikes tea\n</memory>\n<clock>\nnoon\n</clock>")
        assertEquals(listOf(null, "memory", "clock"), tagged.map { it.title })
        assertEquals("likes tea", tagged[1].body)
        val headed = systemSections("# Memory\nfoo\n```\n# not a heading\n```\n## Tools\nbar")
        assertEquals(listOf("Memory", "Tools"), headed.map { it.title })
        assertTrue(headed[0].body.contains("# not a heading"))
        assertEquals("Memory", promptSectionLabel("memory"))
    }

    @Test
    fun changesNameEachUpdatedOrRemovedSection() {
        val changes = sectionChanges("Updated system prompt section \"clock\":\n\nnoon\n\nRemoved system prompt section \"web\".")
        assertEquals(listOf("clock", "web"), changes.map { it.name })
        assertEquals("noon", changes[0].body)
        assertTrue(changes[1].removed)
        assertEquals("plain", sectionChanges("plain").single().body)
    }

    @Test
    fun numbersAreGrouped() {
        assertEquals("13,584", groupedNumber(13584))
    }
}
