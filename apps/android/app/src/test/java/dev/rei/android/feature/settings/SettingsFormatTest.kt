package dev.rei.android.feature.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsFormatTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

    @Test fun parsesMemoryDocuments() {
        val docs = parseMemory(json("""{"profile":[{"id":"l1","text":"Likes tea","confirmedAt":5}],"agents":[{"agentId":"a1","lines":[]}]}"""))
        assertEquals(2, docs.size)
        assertEquals(MemoryEntry("l1", "Likes tea", 5L), docs[0].entries.single())
        assertEquals("a1", docs[1].agentId)
    }

    @Test fun triggerSummariesNameTheirState() {
        assertEquals("Every day at 09:00 · Paused after failures", TriggerItem("t", "n", "paused", "Every day at 09:00", null, "failures").summary)
        assertEquals("On new mail · Done", TriggerItem("t", "n", "done", "On new mail", null, null).summary)
        assertEquals("Failed", statusLabel("failed"))
        assertEquals("No changes", statusLabel("no_changes"))
        assertEquals("Removed", verb("remove"))
    }
}
