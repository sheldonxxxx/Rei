package dev.rei.android.feature.settings

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeTest {
    private fun compaction(enabled: Boolean = true) = buildJsonObject {
        put("enabled", enabled); put("reserveTokens", 16384); put("keepRecentTokens", 20000); put("backgroundTokens", 4000)
    }

    private val context = buildJsonObject {
        put("compaction", compaction())
        put("home", buildJsonObject { put("idleGapMinutes", 30); put("maxTokens", 50000) })
        put("defaults", buildJsonObject {
            put("compaction", compaction())
            put("home", buildJsonObject { put("idleGapMinutes", 30); put("maxTokens", 50000) })
        })
    }

    private fun behaviorSettings(maxOutput: Int? = null) = buildJsonObject {
        put("runLimits", buildJsonObject { put("maxModelCalls", 200); put("maxRunMinutes", 60) })
        put("retry", buildJsonObject { put("maxRetries", 3); put("baseDelaySeconds", 2) })
        put("memory", buildJsonObject { put("injectProfile", true); put("injectRecent", false); put("historyHits", 5) })
        put("generation", buildJsonObject { if (maxOutput == null) put("maxOutputTokens", JsonNull) else put("maxOutputTokens", maxOutput) })
        put("discovery", buildJsonObject { put("maxConnectorTools", 8); put("maxSkills", 3) })
        put("search", buildJsonObject { put("useOpenAiNativeSearch", false) })
    }

    private val behavior = buildJsonObject {
        put("settings", behaviorSettings())
        put("defaults", behaviorSettings())
        put("ceilings", buildJsonObject { put("maxModelCalls", 500); put("maxRunMinutes", 240); put("maxRetries", 10) })
    }

    private val standard = buildJsonObject { put("model", "a/b"); put("firstEventMs", 120000); put("idleMs", 30000); put("totalMs", 600000) }

    private val sections get() = runtimeSections(context, behavior)

    @Test
    fun draftReadsServerValuesAndSecondsFromMilliseconds() {
        val draft = runtimeDraft(context, behavior, standard)
        assertEquals("16384", draft.texts["compaction.reserveTokens"])
        assertEquals("120", draft.texts["timeout.firstEventMs"])
        assertEquals("", draft.texts["generation.maxOutputTokens"])
        assertEquals(false, draft.flags[Flag.InjectRecent])
    }

    @Test
    fun ceilingsAndDefaultsComeFromTheServer() {
        val calls = sections.flatMap { it.fields }.first { it.key == "runLimits.maxModelCalls" }
        assertEquals(500L, calls.max)
        assertEquals(dev.rei.android.ui.UiText.Literal("200"), calls.defaultText)
        assertEquals(
            dev.rei.android.ui.UiText.Resource(dev.rei.android.R.string.settings_runtime_none),
            sections.flatMap { it.fields }.first { it.key == "generation.maxOutputTokens" }.defaultText,
        )
    }

    @Test
    fun unchangedDraftSavesWithoutTimeouts() {
        val save = runtimeSave(sections, runtimeDraft(context, behavior, standard), standard) as RuntimeSave.Ready
        assertNull(save.timeouts)
        assertEquals(JsonNull, (save.behavior["generation"] as JsonObject)["maxOutputTokens"])
        assertEquals(JsonPrimitive(true), (save.context["compaction"] as JsonObject)["enabled"])
        assertEquals(JsonPrimitive(false), (save.behavior["memory"] as JsonObject)["injectRecent"])
    }

    @Test
    fun changedTimeoutIsSentInMilliseconds() {
        val draft = runtimeDraft(context, behavior, standard)
        val edited = draft.copy(texts = draft.texts + ("timeout.idleMs" to "45"))
        val save = runtimeSave(sections, edited, standard) as RuntimeSave.Ready
        val timeouts = save.timeouts
        assertNotNull(timeouts)
        assertEquals(setOf("idleMs"), timeouts!!.keys)
        assertEquals(JsonPrimitive(45000L), timeouts["idleMs"])
    }

    @Test
    fun outOfRangeNamesTheFieldAndItsTab() {
        val draft = runtimeDraft(context, behavior, standard)
        val edited = draft.copy(texts = draft.texts + ("runLimits.maxModelCalls" to "501"))
        val invalid = runtimeSave(sections, edited, standard) as RuntimeSave.Invalid
        assertEquals(RuntimeTab.Runs, invalid.tab)
        assertEquals(
            dev.rei.android.ui.UiText.Resource(
                dev.rei.android.R.string.settings_range_between,
                dev.rei.android.ui.UiText.Resource(dev.rei.android.R.string.settings_runtime_f_calls_label),
                "1",
                "500",
            ),
            invalid.message,
        )
        val blank = runtimeSave(sections, draft.copy(texts = draft.texts + ("home.maxTokens" to "")), standard) as RuntimeSave.Invalid
        assertEquals(RuntimeTab.Context, blank.tab)
        assertEquals(
            dev.rei.android.ui.UiText.Resource(
                dev.rei.android.R.string.settings_range_min,
                dev.rei.android.ui.UiText.Resource(dev.rei.android.R.string.settings_runtime_f_budget_label),
                "1",
            ),
            blank.message,
        )
    }

    @Test
    fun resetUsesServerDefaultsAndStockDeadlines() {
        assertEquals(behavior["defaults"], runtimeResetBehavior(behavior))
        assertEquals(JsonPrimitive(600000L), runtimeResetDeadlines()["totalMs"])
    }
}
