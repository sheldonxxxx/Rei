package dev.rei.android.feature.settings

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
internal enum class RuntimeTab(val label: String) { Context("Context"), Runs("Runs"), Tools("Tools") }

internal enum class Flag { CompactionEnabled, InjectProfile, InjectRecent, NativeSearch }

internal data class RuntimeField(
    /** `group.field`, the name the request uses for the value. */
    val key: String,
    val label: String,
    val help: String,
    val defaultText: String,
    val min: Long,
    val max: Long? = null,
    /** An empty box saves as null, which means the model's own limit. */
    val allowEmpty: Boolean = false,
)

internal data class RuntimeSection(
    val tab: RuntimeTab,
    val title: String,
    val blurb: String,
    val switches: List<Pair<Flag, String>> = emptyList(),
    val fields: List<RuntimeField> = emptyList(),
)

internal val DefaultFlags = mapOf(Flag.CompactionEnabled to true, Flag.InjectProfile to true, Flag.InjectRecent to true, Flag.NativeSearch to false)

/** Chat call deadlines in milliseconds, as the server's defaults. */
internal val DefaultDeadlines = mapOf("firstEventMs" to 120_000L, "idleMs" to 500_000L, "totalMs" to 600_000L)

private val TimeoutFields = listOf(
    Triple("firstEventMs", "First response", "Maximum time before the model starts responding."),
    Triple("idleMs", "Response pause", "Maximum time between response updates."),
    Triple("totalMs", "Total call", "Maximum time for the complete model call."),
)

private fun JsonObject.sub(key: String): JsonObject = this[key] as? JsonObject ?: JsonObject(emptyMap())
private fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.toLongOrNull()
private fun JsonObject.flag(key: String, fallback: Boolean): Boolean = (this[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.let { it == "true" } ?: fallback

private fun whole(value: Long?): String = value?.let(::grouped) ?: "none"

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
            RuntimeTab.Context, "Automatic summaries",
            "When a chat outgrows its model's window, Rei summarizes its older messages. Off, such a chat fails instead of being summarized.",
            switches = listOf(Flag.CompactionEnabled to "Summarize long chats automatically"),
            fields = listOf(
                RuntimeField("compaction.reserveTokens", "Room kept for the answer (tokens)", "Rei summarizes once a chat is within this many tokens of the model's context window.", whole(compaction.number("reserveTokens")), 1),
                RuntimeField("compaction.keepRecentTokens", "Recent context kept word for word (tokens)", "About how much of the newest conversation a summary leaves as it is.", whole(compaction.number("keepRecentTokens")), 1),
                RuntimeField("compaction.backgroundTokens", "Start early in the background (tokens)", "Summarize this many tokens before the limit, while the chat keeps working. 0 turns early summaries off.", whole(compaction.number("backgroundTokens")), 0),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Context, "Home chat",
            "Rei summarizes older turns when the chat grows or has been quiet. The full transcript stays in the chat.",
            fields = listOf(
                RuntimeField("home.idleGapMinutes", "Idle time before summarizing (minutes)", "After this much time without a message from you, Rei checks whether there is enough older context to summarize.", whole(home.number("idleGapMinutes")), 1),
                RuntimeField("home.maxTokens", "Context budget (tokens)", "Working budget for Home chat. Rei starts summarizing before it reaches this limit.", whole(home.number("maxTokens")), 1),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs, "Run limits",
            "Safety limits that stop a run that loops. They can't be turned off; the highest allowed is $maxCalls calls and $maxMinutes minutes.",
            fields = listOf(
                RuntimeField("runLimits.maxModelCalls", "Model calls per run", "A run is stopped before its next call after this many.", default("runLimits", "maxModelCalls"), 1, maxCalls),
                RuntimeField("runLimits.maxRunMinutes", "Longest run (minutes)", "A run over this time is stopped before its next model call.", default("runLimits", "maxRunMinutes"), 1, maxMinutes),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs, "Agent chat timeouts", "Set how long Rei waits during a model call in an agent chat.",
            fields = TimeoutFields.map { (field, label, help) ->
                RuntimeField("timeout.$field", "$label (seconds)", help, whole(DefaultDeadlines.getValue(field) / 1000), 1, 7200)
            },
        ),
        RuntimeSection(
            RuntimeTab.Runs, "Retries",
            "When a model call fails for a temporary reason. Only the model call is retried, never a tool's side effects.",
            fields = listOf(
                RuntimeField("retry.maxRetries", "Retries per failed call", "0 turns retries off.", default("retry", "maxRetries"), 0, maxRetries),
                RuntimeField("retry.baseDelaySeconds", "Wait before the first retry (seconds)", "Later retries wait longer.", default("retry", "baseDelaySeconds"), 1, 60),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Runs, "Output",
            "Limits how long a single model reply may be. Leave empty to use each model's own limit; this never raises it.",
            fields = listOf(
                RuntimeField("generation.maxOutputTokens", "Reply length cap (tokens)", "Empty means no cap.", default("generation", "maxOutputTokens"), 1, 10_000_000, allowEmpty = true),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Context, "Memory", "What agents see from memory at the start of each reply.",
            switches = listOf(Flag.InjectProfile to "Put the profile and agent notes in context", Flag.InjectRecent to "Put recent chats in context"),
            fields = listOf(
                RuntimeField("memory.historyHits", "Chat history results", "How many matches a history search returns.", default("memory", "historyHits"), 1, 20),
            ),
        ),
        RuntimeSection(
            RuntimeTab.Tools, "Web search",
            "OpenAI models can search with OpenAI's built-in tool instead of the web_search tool and the providers set up under Providers. Other models keep using web_search.",
            switches = listOf(Flag.NativeSearch to "Use OpenAI's built-in search with OpenAI models"),
        ),
        RuntimeSection(
            RuntimeTab.Tools, "Capability search", "How much the search_capabilities tool loads for an agent at once.",
            fields = listOf(
                RuntimeField("discovery.maxConnectorTools", "Connector tools per search", "More tools make the model's list longer.", default("discovery", "maxConnectorTools"), 1, 20),
                RuntimeField("discovery.maxSkills", "Skills per search", "0 stops search from suggesting skills.", default("discovery", "maxSkills"), 0, 10),
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
    data class Invalid(val tab: RuntimeTab, val message: String) : RuntimeSave
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
