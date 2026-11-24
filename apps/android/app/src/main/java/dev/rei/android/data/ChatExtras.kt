package dev.rei.android.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/** One step of a run, as the chat's tool activity row and Inspect show it (`StepSummary` in the protocol). */
data class TraceStep(
    val id: String,
    val type: String,
    val status: String,
    val startedAt: Long,
    val latencyMs: Long?,
    val sideEffect: Boolean,
    val toolName: String?,
    val decision: String?,
    val approvalId: String?,
    val summary: String?,
    val activity: String?,
    val pageId: String?,
    val pageTitle: String?,
    val webTitle: String?,
    val webHost: String?,
    val model: String?,
    val tokens: Long?,
    val errorCode: String?,
)

data class RunTrace(
    val runId: String,
    val status: String,
    val triggerMessageId: String?,
    val steps: List<TraceStep>,
    val durationMs: Long?,
    val approvalWaitMs: Long,
    /** A failed run the user went on from with Continue: a later run answers it. */
    val continued: Boolean = false,
) {
    val live get() = status == "running" || status == "queued"
}

data class TracePage(val runs: List<RunTrace>, val next: String?)

internal fun JsonObject.traceStep() = TraceStep(
    id = string("id"),
    type = string("type"),
    status = string("status"),
    startedAt = this["startedAt"]?.jsonPrimitive?.long ?: 0,
    latencyMs = optionalString("latencyMs")?.toLongOrNull(),
    sideEffect = this["sideEffect"]?.jsonPrimitive?.content == "true",
    toolName = optionalString("toolName"),
    decision = optionalString("decision"),
    approvalId = optionalString("approvalId"),
    summary = optionalString("summary"),
    activity = optionalString("activity"),
    pageId = (get("page") as? JsonObject)?.optionalString("id"),
    pageTitle = (get("page") as? JsonObject)?.optionalString("title"),
    webTitle = (get("web") as? JsonObject)?.optionalString("title"),
    webHost = (get("web") as? JsonObject)?.optionalString("host"),
    model = optionalString("model"),
    tokens = (get("tokens") as? JsonObject)?.optionalString("total")?.toLongOrNull(),
    errorCode = optionalString("errorCode"),
)

internal fun JsonObject.runTrace(): RunTrace {
    val run = obj("run")
    val totals = get("totals") as? JsonObject
    return RunTrace(
        runId = run.string("id"),
        status = run.string("status"),
        triggerMessageId = optionalString("triggerMessageId"),
        steps = objects("steps").map { it.traceStep() },
        durationMs = totals?.optionalString("durationMs")?.toLongOrNull(),
        approvalWaitMs = totals?.optionalString("approvalWaitMs")?.toLongOrNull() ?: 0,
        continued = optionalString("continued") == "true",
    )
}

/** `GET /api/sessions/:id/trace`: the newest runs first. */
suspend fun ReiApi.trace(sessionId: String, before: String? = null): TracePage {
    val body = request("GET", listOf("api", "sessions", sessionId, "trace"), query = if (before != null) mapOf("before" to before) else emptyMap())
    return TracePage(body.objects("runs").map { it.runTrace() }, body.optionalString("next"))
}

/** `GET /api/steps/:id`: the payload as recorded, shown in Inspect. */
suspend fun ReiApi.stepDetail(stepId: String): JsonObject = request("GET", listOf("api", "steps", stepId))

/** `POST /api/sessions/:id/version`: show the neighbouring version of an edited message. */
suspend fun ReiApi.switchVersion(sessionId: String, messageId: String, next: Boolean) {
    request("POST", listOf("api", "sessions", sessionId, "version"), buildJsonObject {
        put("messageId", messageId)
        put("to", if (next) "next" else "prev")
    })
}

/** `POST /api/sessions/:id/continue`: carry on after a failed run. */
suspend fun ReiApi.continueRun(sessionId: String) {
    request("POST", listOf("api", "sessions", sessionId, "continue"))
}

data class ModelCatalog(
    val default: String,
    val models: List<String>,
    val labels: Map<String, String>,
    val thinkingLevels: Map<String, List<String>>,
) {
    fun label(model: String?): String = (model ?: default).let { labels[it] ?: it.substringAfterLast('/') }
}

/** `GET /api/models`. */
suspend fun ReiApi.models(): ModelCatalog {
    val body = request("GET", listOf("api", "models"))
    fun JsonObject?.strings() = this?.mapValues { it.value.jsonPrimitive.content }.orEmpty()
    return ModelCatalog(
        default = body.optionalString("default").orEmpty(),
        models = (body["models"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content },
        labels = (body["labels"] as? JsonObject).strings(),
        thinkingLevels = ((body["thinkingLevels"] as? JsonObject) ?: JsonObject(emptyMap())).mapValues { (_, value) ->
            (value as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
        },
    )
}

/** `PATCH /api/agents/:id`: change an agent's model (null: the default) or reasoning effort. */
suspend fun ReiApi.updateAgentSettings(agentId: String, model: String? = null, clearModel: Boolean = false, thinkingLevel: String? = null): ChatAgent =
    request("PATCH", listOf("api", "agents", agentId), buildJsonObject {
        if (clearModel) put("model", JsonNull) else if (model != null) put("model", model)
        if (thinkingLevel != null) put("thinkingLevel", thinkingLevel)
    }).obj("agent").chatAgent()

data class ContextUsage(val maxTokens: Long?, val usedTokens: Long?, val updatedAt: Long?) {
    /** 0–100, or null when the model call hasn't reported yet. */
    val percent: Int? get() = if (maxTokens != null && maxTokens > 0 && usedTokens != null) ((usedTokens * 100) / maxTokens).toInt() else null
}

/** `GET /api/sessions/:id/context`: the latest model call's context use. */
suspend fun ReiApi.contextUsage(sessionId: String): ContextUsage {
    val body = request("GET", listOf("api", "sessions", sessionId, "context"))
    val input = body.optionalString("inputTokens")?.toLongOrNull()
    val output = body.optionalString("outputTokens")?.toLongOrNull()
    return ContextUsage(
        maxTokens = body.optionalString("maxTokens")?.toLongOrNull(),
        usedTokens = if (input != null && output != null) input + output else null,
        updatedAt = body.optionalString("updatedAt")?.toLongOrNull(),
    )
}

data class SkillOption(val id: String, val name: String, val description: String, val version: Int)

/** `GET /api/sessions/:id/skills`: what `/` offers in the composer. */
suspend fun ReiApi.sessionSkills(sessionId: String): List<SkillOption> =
    request("GET", listOf("api", "sessions", sessionId, "skills")).objects("skills").map {
        SkillOption(it.string("id"), it.string("name"), it.optionalString("description").orEmpty(), it["version"]?.jsonPrimitive?.int ?: 1)
    }

/** A user message with chosen skills ("/" chips) carries them in `selectedSkills`. */
internal fun skillsJson(skills: List<SkillOption>): JsonArray = JsonArray(skills.map {
    buildJsonObject {
        put("id", it.id)
        put("version", it.version)
    }
})
