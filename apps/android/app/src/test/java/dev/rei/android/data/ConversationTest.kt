package dev.rei.android.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationTest {
    @Test
    fun patchReordersUpsertsRemovesAndClearsHistoryCursor() {
        val state = ConversationStream()
        state.apply("snapshot", json(
            """{"epoch":"e","rev":0,"view":{"version":2,"session":$SessionJson,"items":[${item("one")},${item("two")}],"before":"older","runs":[],"live":{"runId":null}}}""",
        ))
        val update = state.apply("patch", json(
            """{"epoch":"e","rev":1,"upsert":[${item("two", "updated")},${item("three")}],"remove":["one"],"order":["three","missing","two"],"before":null}""",
        )) as SessionEvent.Updated
        assertEquals(listOf("three", "two"), update.detail.messages.map { it.id })
        assertEquals("updated", update.detail.messages.last().text)
        assertNull(update.detail.before)
        assertNull(state.apply("patch", json("""{"epoch":"another","rev":2}""")))
    }

    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject

    private fun item(id: String, text: String = id) =
        """{"id":"$id","role":"assistant","text":"$text","status":"complete","createdAt":5}"""

    private companion object {
        const val SessionJson = """{"id":"s1","agentId":"a","title":"Chat","preview":"","origin":"user","status":"idle","unread":0}"""
    }
}
