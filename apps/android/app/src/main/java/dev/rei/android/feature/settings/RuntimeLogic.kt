package dev.rei.android.feature.settings

import androidx.annotation.StringRes
import dev.rei.android.R
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The Runtime page's fields, limits and request bodies, kept apart from the screen so they can be tested. The numbers and
 * wording mirror the web's Runtime page; the server validates every value again on save.
 */
internal enum class RuntimeTab(@StringRes val labelRes: Int) {
    Context(R.string.settings_runtime_tab_context),
    Runs(R.string.settings_runtime_tab_runs),
    Tools(R.string.settings_runtime_tab_tools),
}

internal enum class Flag { CompactionEnabled, InjectProfile, InjectRecent, NativeSearch }

internal data class RuntimeField(
    /** `group.field`, the name the request uses for the value. */
    val key: String,
    val label: UiText,
    val help: UiText,
    val defaultText: UiText,
    val min: Long,
    val max: Long? = null,
    /** An empty box saves as null, which means the model's own limit. */
    val allowEmpty: Boolean = false,
)

internal data class RuntimeSection(
    val tab: RuntimeTab,
    val title: UiText,
    val blurb: UiText,
    val switches: List<Pair<Flag, UiText>> = emptyList(),
    val fields: List<RuntimeField> = emptyList(),
)

internal val DefaultFlags = mapOf(Flag.CompactionEnabled to true, Flag.InjectProfile to true, Flag.InjectRecent to true, Flag.NativeSearch to false)

/** Chat call deadlines in milliseconds, as the server's defaults. */
internal val DefaultDeadlines = mapOf("firstEventMs" to 120_000L, "idleMs" to 500_000L, "totalMs" to 600_000L)

private val TimeoutFields = listOf(
    Triple("firstEventMs", R.string.settings_runtime_timeout_first, R.string.settings_runtime_timeout_first_help),
    Triple("idleMs", R.string.settings_runtime_timeout_idle, R.string.settings_runtime_timeout_idle_help),
    Triple("totalMs", R.string.settings_runtime_timeout_total, R.string.settings_runtime_timeout_total_help),
)

private fun JsonObject.sub(key: String): JsonObject = this[key] as? JsonObject ?: JsonObject(emptyMap())
private fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.toLongOrNull()
private fun JsonObject.flag(key: String, fallback: Boolean): Boolean = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.let { it == "true" } ?: fallback

private fun whole(value: Long?): UiText = value?.let { UiText.Literal(grouped(it)) } ?: UiText.Resource(R.string.settings_runtime_none)

/** Every section of the page, in order, with the defaults and ceilings the server reported. */
internal fun runtimeSections(context: JsonObject, behavior: JsonObject): List<RuntimeSection> {
    val compaction = context.sub("defaults").sub("compaction")
    val home = context.sub("defaults").sub("home")
    val defaults = behavior.sub("defaults")
    val ceilings = behavior.sub("ceilings")
    fun default(group: String, key: String) = whole(defaults.sub(group).number(key))
    val maxCalls = ceilings.number("maxModelCalls") ?: 1_000L
    val maxMinutes = ceilings.number("maxRunMinutes") ?: 1_000L
    val maxRetries = ceilings.number("maxRetries") ?: 10L
    return listOf(
        RuntimeSection(
            RuntimeTab.Context,
            UiText.Resource(R.string.settings_runtime_sec_auto_title),
            UiText.Resource(R.string.settings_runtime_sec_auto_blurb),
            switches = listOf(Flag.CompactionEnabled to UiText.Resource(R.string.settings_runtime_sw_compaction)),
            fields = listOf(
                RuntimeField("compaction.reserveTokens", UiText.Resource(R.string.settings_runtime_f_reserve_label), UiText.Resource(R.string.settings_runtime_f_reserve_help), whole(compaction.number("reserveTokens")), 1),
                RuntimeField("compaction.keepRecentTokens", UiText.Resource(R.string.settings_runtime_f_recent_label), UiText.Resource(R.string.settings_runtime_f_recent_help), whole(compaction.number("keepRecentTokens")), 1),
                RuntimeField("compaction.backgroundTokens", UiText.Resource(R.string.settings_runtime_f_bg_label), UiText.Resource(R.string.settings_runtime_f_bg_help), whole(compaction.number("backgroundTokens")), 0),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Context,
            UiText.Resource(R.string.settings_runtime_sec_home_title),
            UiText.Resource(R.string.settings_runtime_sec_home_blurb),
            fields = listOf(
                RuntimeField("home.idleGapMinutes", UiText.Resource(R.string.settings_runtime_f_idle_label), UiText.Resource(R.string.settings_runtime_f_idle_help), whole(home.number("idleGapMinutes")), 1),
                RuntimeField("home.maxTokens", UiText.Resource(R.string.settings_runtime_f_budget_label), UiText.Resource(R.string.settings_runtime_f_budget_help), whole(home.number("maxTokens")), 1),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs,
            UiText.Resource(R.string.settings_runtime_sec_limits_title),
            UiText.Resource(R.string.settings_runtime_sec_limits_blurb, maxCalls, maxMinutes),
            fields = listOf(
                RuntimeField("runLimits.maxModelCalls", UiText.Resource(R.string.settings_runtime_f_calls_label), UiText.Resource(R.string.settings_runtime_f_calls_help), default("runLimits", "maxModelCalls"), 1, maxCalls),
                RuntimeField("runLimits.maxRunMinutes", UiText.Resource(R.string.settings_runtime_f_minutes_label), UiText.Resource(R.string.settings_runtime_f_minutes_help), default("runLimits", "maxRunMinutes"), 1, maxMinutes),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs,
            UiText.Resource(R.string.settings_runtime_sec_timeouts_title),
            UiText.Resource(R.string.settings_runtime_sec_timeouts_blurb),
            fields = TimeoutFields.map { (field, labelRes, helpRes) ->
                RuntimeField(
                    "timeout.$field",
                    UiText.Resource(R.string.settings_runtime_timeout_label, UiText.Resource(labelRes)),
                    UiText.Resource(helpRes),
                    whole(DefaultDeadlines.getValue(field) / 1000),
                    1,
                    7200,
                )
            },
        ),
        RuntimeSection(
            RuntimeTab.Runs,
            UiText.Resource(R.string.settings_runtime_sec_retries_title),
            UiText.Resource(R.string.settings_runtime_sec_retries_blurb),
            fields = listOf(
                RuntimeField("retry.maxRetries", UiText.Resource(R.string.settings_runtime_f_retries_label), UiText.Resource(R.string.settings_runtime_f_retries_help), default("retry", "maxRetries"), 0, maxRetries),
                RuntimeField("retry.baseDelaySeconds", UiText.Resource(R.string.settings_runtime_f_delay_label), UiText.Resource(R.string.settings_runtime_f_delay_help), default("retry", "baseDelaySeconds"), 1, 60),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs,
            UiText.Resource(R.string.settings_runtime_sec_output_title),
            UiText.Resource(R.string.settings_runtime_sec_output_blurb),
            fields = listOf(
                RuntimeField("generation.maxOutputTokens", UiText.Resource(R.string.settings_runtime_f_output_label), UiText.Resource(R.string.settings_runtime_f_output_help), default("generation", "maxOutputTokens"), 1, 10_000_000, allowEmpty = true),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Context,
            UiText.Resource(R.string.settings_page_memory),
            UiText.Resource(R.string.settings_runtime_sec_memory_blurb),
            switches = listOf(
                Flag.InjectProfile to UiText.Resource(R.string.settings_runtime_sw_profile),
                Flag.InjectRecent to UiText.Resource(R.string.settings_runtime_sw_recent),
            ),
            fields = listOf(
                RuntimeField("memory.historyHits", UiText.Resource(R.string.settings_runtime_f_hits_label), UiText.Resource(R.string.settings_runtime_f_hits_help), default("memory", "historyHits"), 1, 20),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Tools,
            UiText.Resource(R.string.settings_providers_section_search),
            UiText.Resource(R.string.settings_runtime_sec_search_blurb),
            switches = listOf(Flag.NativeSearch to UiText.Resource(R.string.settings_runtime_sw_native_search)),
        ),
        RuntimeSection(
            RuntimeTab.Tools,
            UiText.Resource(R.string.settings_runtime_sec_cap_title),
            UiText.Resource(R.string.settings_runtime_sec_cap_blurb),
            fields = listOf(
                RuntimeField("discovery.maxConnectorTools", UiText.Resource(R.string.settings_runtime_f_tools_label), UiText.Resource(R.string.settings_runtime_f_tools_help), default("discovery", "maxConnectorTools"), 1, 20),
                RuntimeField("discovery.maxSkills", UiText.Resource(R.string.settings_runtime_f_skills_label), UiText.Resource(R.string.settings_runtime_f_skills_help), default("discovery", "maxSkills"), 0, 10),
            ),
        ),
    )
}

/** What the page edits: one text per number field and one boolean per switch. */
internal data class RuntimeDraft(val texts: Map<String, String>, val flags: Map<Flag, Boolean>)

/** The draft the server's current settings make. [standard] is the `standard` model setting (deadlines in milliseconds). */
internal fun runtimeDraft(context: JsonObject, behavior: JsonObject, standard: JsonObject): RuntimeDraft {
    val compaction = context.sub("compaction")
    val home = context.sub("home")
    val s = behavior.sub("settings")
    fun text(value: Long?) = value?.toString() ?: ""
    val texts = buildMap {
        put("compaction.reserveTokens", text(compaction.number("reserveTokens")))
        put("compaction.keepRecentTokens", text(compaction.number("keepRecentTokens")))
        put("compaction.backgroundTokens", text(compaction.number("backgroundTokens")))
        put("home.idleGapMinutes", text(home.number("idleGapMinutes")))
        put("home.maxTokens", text(home.number("maxTokens")))
        put("runLimits.maxModelCalls", text(s.sub("runLimits").number("maxModelCalls")))
        put("runLimits.maxRunMinutes", text(s.sub("runLimits").number("maxRunMinutes")))
        put("retry.maxRetries", text(s.sub("retry").number("maxRetries")))
        put("retry.baseDelaySeconds", text(s.sub("retry").number("baseDelaySeconds")))
        put("memory.historyHits", text(s.sub("memory").number("historyHits")))
        put("generation.maxOutputTokens", text(s.sub("generation").number("maxOutputTokens")))
        put("discovery.maxConnectorTools", text(s.sub("discovery").number("maxConnectorTools")))
        put("discovery.maxSkills", text(s.sub("discovery").number("maxSkills")))
        for ((field, _, _) in TimeoutFields) put("timeout.$field", text(standard.number(field)?.let { (it + 500) / 1000 }))
    }
    val flags = mapOf(
        Flag.CompactionEnabled to context.sub("compaction").flag("enabled", true),
        Flag.InjectProfile to s.sub("memory").flag("injectProfile", true),
        Flag.InjectRecent to s.sub("memory").flag("injectRecent", true),
        Flag.NativeSearch to s.sub("search").flag("useOpenAiNativeSearch", false),
    )
    return RuntimeDraft(texts, flags)
}

/** The three requests a save makes, or the first field that is not valid and the tab it is on. */
internal sealed interface RuntimeSave {
    data class Invalid(val tab: RuntimeTab, val message: UiText) : RuntimeSave
    data class Ready(val context: JsonObject, val behavior: JsonObject, val timeouts: JsonObject?) : RuntimeSave
}

/** [standard] holds the deadlines now stored, in milliseconds; only a deadline that changed is sent. */
internal fun runtimeSave(sections: List<RuntimeSection>, draft: RuntimeDraft, standard: JsonObject): RuntimeSave {
    val values = LinkedHashMap<String, Long?>()
    for (section in sections) for (field in section.fields) {
        val text = draft.texts[field.key].orEmpty().trim()
        if (text.isEmpty() && field.allowEmpty) {
            values[field.key] = null
            continue
        }
        values[field.key] = parseWholeNumber(text, field.min, field.max) ?: return RuntimeSave.Invalid(section.tab, rangeMessage(field.label, field.min, field.max))
    }
    fun group(name: String): Map<String, JsonElement> = values
        .filterKeys { it.startsWith("$name.") }
        .entries.associate { (key, value) -> key.substring(name.length + 1) to (value?.let { JsonPrimitive(it) } ?: JsonNull) }
    fun flag(which: Flag) = draft.flags[which] ?: DefaultFlags.getValue(which)
    val context = buildJsonObject {
        put("compaction", JsonObject(group("compaction") + ("enabled" to JsonPrimitive(flag(Flag.CompactionEnabled)))))
        put("home", JsonObject(group("home")))
    }
    val behavior = buildJsonObject {
        put("runLimits", JsonObject(group("runLimits")))
        put("retry", JsonObject(group("retry")))
        put("memory", JsonObject(group("memory") + mapOf("injectProfile" to JsonPrimitive(flag(Flag.InjectProfile)), "injectRecent" to JsonPrimitive(flag(Flag.InjectRecent)))))
        put("generation", JsonObject(group("generation")))
        put("discovery", JsonObject(group("discovery")))
        put("search", buildJsonObject { put("useOpenAiNativeSearch", flag(Flag.NativeSearch)) })
    }
    val changed = TimeoutFields.mapNotNull { (field, _, _) ->
        val seconds = values["timeout.$field"] ?: return@mapNotNull null
        val stored = standard.number(field)?.let { (it + 500) / 1000 }
        if (seconds != stored) field to JsonPrimitive(seconds * 1000) else null
    }
    return RuntimeSave.Ready(context, behavior, changed.takeIf { it.isNotEmpty() }?.let { JsonObject(it.toMap()) })
}

/** The request that restores every default: the server's own default behavior, no overrides for context and the stock deadlines. */
internal fun runtimeResetBehavior(behavior: JsonObject): JsonObject = behavior.sub("defaults")

internal fun runtimeResetDeadlines(): JsonObject = buildJsonObject { DefaultDeadlines.forEach { (key, value) -> put(key, value) } }
