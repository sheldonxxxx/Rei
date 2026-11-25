package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.ui.UiText
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
        assertEquals(
            UiText.Resource(R.string.settings_triggers_summary_pair, "Every day at 09:00", UiText.Resource(R.string.settings_triggers_paused_failures)),
            TriggerItem("t", "n", "paused", "Every day at 09:00", null, "failures").summary,
        )
        assertEquals(
            UiText.Resource(R.string.settings_triggers_summary_pair, "On new mail", UiText.Resource(R.string.settings_triggers_done)),
            TriggerItem("t", "n", "done", "On new mail", null, null).summary,
        )
        assertEquals(UiText.Resource(R.string.settings_triggers_status_failed), statusLabel("failed"))
        assertEquals(UiText.Resource(R.string.settings_triggers_status_no_changes), statusLabel("no_changes"))
        assertEquals(UiText.Resource(R.string.settings_memory_verb_remove), verb("remove"))
    }
}
