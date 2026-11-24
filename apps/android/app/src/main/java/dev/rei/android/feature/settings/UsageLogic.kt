package dev.rei.android.feature.settings

import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import kotlinx.serialization.json.JsonObject
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale

/**
 * Pure rules for the Usage page, following the web's: the periods and their names, how a total reads (abbreviated, a lower
 * bound when some calls did not report, "Unavailable" when none did), the custom range checks, and how search attempts are
 * described. Days and periods are UTC, as the server counts them.
 */

internal val UsagePeriods = listOf(
    "today" to "Today", "7d" to "Last 7 days", "30d" to "Last 30 days",
    "month" to "This month", "year" to "This year", "all" to "All time", "custom" to "Custom range",
)

/** One token total: null when no call reported it, a lower bound when some calls did not. */
internal data class Metric(val value: Long?, val lowerBound: Boolean = false) {
    /** The abbreviated figure, "≥" in front of a lower bound, "Unavailable" when nothing was reported. */
    val text: String get() = if (value == null) "Unavailable" else (if (lowerBound) "≥" else "") + compactCount(value)
}

internal data class UsageTotals(
    val inputTotal: Metric,
    val inputCached: Metric,
    val inputUncached: Metric,
    val outputTotal: Metric,
    val totalProcessed: Metric,
    val calls: Long,
    val callsUnreported: Long,
    val cacheHitPercent: Double?,
)

/** A nested object, or an empty one when the server left it out. */
private fun JsonObject.section(key: String): JsonObject = this[key] as? JsonObject ?: JsonObject(emptyMap())

internal fun JsonObject.usageTotals(): UsageTotals {
    val tokens = section("tokens")
    val unknown = section("unknown")
    fun metric(key: String): Metric {
        val value = tokens.optionalString(key)?.toLongOrNull()
        return Metric(value, value != null && (unknown.optionalString(key)?.toLongOrNull() ?: 0) > 0)
    }
    return UsageTotals(
        metric("inputTotal"), metric("inputCached"), metric("inputUncached"), metric("outputTotal"), metric("totalProcessed"),
        optionalString("modelCalls")?.toLongOrNull() ?: 0, optionalString("callsUnreported")?.toLongOrNull() ?: 0,
        optionalString("cacheHitPercent")?.toDoubleOrNull(),
    )
}

/** `60.0%`, or "Unavailable" when no call reported both input and cached tokens. */
internal fun cacheHitText(percent: Double?): String = if (percent == null) "Unavailable" else String.format(Locale.US, "%.1f%%", percent)

/** A row of a breakdown: what it is and what it used. */
internal data class UsageRow(val label: String, val totals: UsageTotals) {
    /** The bar's weight: tokens processed, or input plus output when that total is missing. */
    val weight: Long get() = totals.totalProcessed.value ?: ((totals.inputTotal.value ?: 0) + (totals.outputTotal.value ?: 0))
}

/** Each row's share of the largest row, 0 to 1, for proportion bars; every non-empty row keeps a visible sliver. */
internal fun shares(rows: List<UsageRow>): List<Float> {
    val max = rows.maxOfOrNull { it.weight } ?: 0
    if (max <= 0) return rows.map { 0f }
    return rows.map { if (it.weight <= 0) 0f else (it.weight.toFloat() / max).coerceIn(0.02f, 1f) }
}

internal fun purposeLabel(purpose: String) = when (purpose) {
    "chat" -> "Chat"
    "memory" -> "Memory maintenance"
    "title" -> "Titles"
    "agent_task" -> "Agent tasks"
    "other" -> "Other"
    else -> purpose.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

internal data class UsageData(
    val from: String,
    val to: String,
    val trackingSince: String,
    val period: String,
    val summary: UsageTotals,
    val byPurpose: List<UsageRow>,
    val byModel: List<UsageRow>,
    val byAgent: List<UsageRow>,
    val daily: List<UsageRow>,
    val search: SearchUsage?,
)

/** The `GET /api/usage` answer. [agentNames] labels the per-agent rows. */
internal fun usageData(body: JsonObject, agentNames: Map<String, String>): UsageData = UsageData(
    from = body.optionalString("from").orEmpty(),
    to = body.optionalString("to").orEmpty(),
    trackingSince = body.optionalString("trackingSince").orEmpty().take(10),
    period = body.optionalString("period").orEmpty(),
    summary = body.section("summary").usageTotals(),
    byPurpose = body.objects("byPurpose").map { UsageRow(purposeLabel(it.string("purpose")), it.section("usage").usageTotals()) },
    byModel = body.objects("byModel").map {
        UsageRow(listOfNotNull(it.optionalString("providerName"), it.optionalString("model")).joinToString(" / "), it.section("usage").usageTotals())
    },
    byAgent = body.objects("byAgent").map {
        val id = it.optionalString("agentId")
        UsageRow(if (id == null) "Unassigned" else agentNames[id] ?: id, it.section("usage").usageTotals())
    },
    daily = body.objects("daily").map { UsageRow(it.string("day"), it.section("usage").usageTotals()) },
    search = (body["search"] as? JsonObject)?.searchUsage(),
)

/** The web's wording for an empty answer: all-time, or the whole of tracking, versus a quiet period. */
internal fun emptyUsageMessage(data: UsageData): String =
    if (data.period == "all" || data.from == data.trackingSince) "No usage recorded since tracking began" else "No usage recorded in this period"

// ---- web search ----

internal data class SearchDetail(val outcome: String, val reason: String?, val fallback: Boolean, val calls: Long)

internal data class SearchProvider(
    val name: String,
    val succeeded: Long,
    val empty: Long,
    val failed: Long,
    val skipped: Long,
    val fallback: Long,
    val answeredAfterFallback: Long,
    val averageMs: Double?,
    val details: List<SearchDetail>,
) {
    val searched get() = succeeded + empty + failed
    /** Failures, empty answers and skips: what is worth explaining. */
    val problems get() = details.filter { it.outcome != "succeeded" }
}

internal data class SearchUsage(
    val searches: Long,
    val answered: Long,
    val empty: Long,
    val failed: Long,
    val withFallback: Long,
    val providers: List<SearchProvider>,
)

internal fun JsonObject.searchUsage(): SearchUsage {
    fun n(key: String) = optionalString(key)?.toLongOrNull() ?: 0
    return SearchUsage(
        n("searches"), n("answered"), n("empty"), n("failed"), n("searchesWithFallback"),
        objects("byProvider").map { p ->
            fun c(key: String) = p.optionalString(key)?.toLongOrNull() ?: 0
            SearchProvider(
                p.optionalString("providerName") ?: p.optionalString("provider").orEmpty(), c("succeeded"), c("empty"), c("failed"), c("skipped"),
                c("fallback"), c("answeredAfterFallback"), p.optionalString("averageMs")?.toDoubleOrNull(),
                p.objects("details").map { d -> SearchDetail(d.optionalString("outcome").orEmpty(), d.optionalString("reason"), d.optionalString("fallback") == "true", d.optionalString("calls")?.toLongOrNull() ?: 0) },
            )
        },
    )
}

private val SearchOutcomes = mapOf("succeeded" to "Succeeded", "empty" to "Empty result", "failed" to "Failed", "skipped" to "Skipped")
private val SearchReasons = mapOf(
    "not_configured" to "not configured", "rate_limited" to "rate limited", "search_rate_limited" to "rate limited",
    "timeout" to "timed out", "search_timeout" to "timed out", "search_failed" to "search failed", "fetch_failed" to "could not be reached",
)

internal fun searchReason(reason: String) = SearchReasons[reason] ?: reason.replace('_', ' ')

/** `Failed · timed out (as fallback)`, with the number of calls it covers. */
internal fun searchDetailLabel(detail: SearchDetail): String {
    val reason = detail.reason?.takeIf { it.isNotEmpty() }?.let { " · ${searchReason(it)}" }.orEmpty()
    return (SearchOutcomes[detail.outcome] ?: detail.outcome) + reason + if (detail.fallback) " (as fallback)" else ""
}

/** The mean time a provider took: whole milliseconds with grouping, or a dash when none reached it. */
internal fun averageText(ms: Double?): String =
    if (ms == null) "—" else NumberFormat.getNumberInstance(Locale.US).apply { maximumFractionDigits = 3 }.format(ms) + " ms"

// ---- the custom range ----

/** A UTC day (`YYYY-MM-DD`) for a moment in time. */
internal fun utcDay(millis: Long): String = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()

/** The start of a UTC day, in milliseconds; null when [day] is not a date. */
internal fun utcDayMillis(day: String): Long? =
    try { LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() } catch (_: Exception) { null }

/** The range a first look at "Custom range" starts from: the last 30 days, ending today. */
internal fun defaultRange(nowMillis: Long): Pair<String, String> = utcDay(nowMillis - 29 * 86_400_000L) to utcDay(nowMillis)

/** What is wrong with a custom range, in the web's words; null when it can be sent. */
internal fun rangeProblem(from: String, to: String): String? = when {
    from.isEmpty() || to.isEmpty() -> "Choose both dates to see usage."
    from > to -> "The To date must be on or after the From date."
    else -> null
}

/** The request's query: only a custom period carries its dates. */
internal fun usageQuery(period: String, from: String, to: String): Map<String, String> =
    if (period == "custom") mapOf("period" to period, "from" to from, "to" to to) else mapOf("period" to period)

