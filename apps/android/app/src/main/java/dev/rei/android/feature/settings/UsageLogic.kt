package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
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
    "today" to R.string.settings_usage_period_today,
    "7d" to R.string.settings_usage_period_7d,
    "30d" to R.string.settings_usage_period_30d,
    "month" to R.string.settings_usage_period_month,
    "year" to R.string.settings_usage_period_year,
    "all" to R.string.settings_usage_period_all,
    "custom" to R.string.settings_usage_period_custom,
)

/** One token total: null when no call reported it, a lower bound when some calls did not. */
internal data class Metric(val value: Long?, val lowerBound: Boolean = false) {
    /** The abbreviated figure, "≥" in front of a lower bound, "Unavailable" when nothing was reported. */
    val text: UiText get() = if (value == null) {
        UiText.Resource(R.string.settings_usage_unavailable)
    } else {
        UiText.Literal((if (lowerBound) "≥" else "") + compactCount(value))
    }
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
internal fun cacheHitText(percent: Double?): UiText =
    if (percent == null) UiText.Resource(R.string.settings_usage_unavailable) else UiText.Literal(String.format(Locale.getDefault(), "%.1f%%", percent))

/** A row of a breakdown: what it is and what it used. */
internal data class UsageRow(val label: UiText, val totals: UsageTotals) {
    /** The bar's weight: tokens processed, or input plus output when that total is missing. */
    val weight: Long get() = totals.totalProcessed.value ?: ((totals.inputTotal.value ?: 0) + (totals.outputTotal.value ?: 0))
}

/** Each row's share of the largest row, 0 to 1, for proportion bars; every non-empty row keeps a visible sliver. */
internal fun shares(rows: List<UsageRow>): List<Float> {
    val max = rows.maxOfOrNull { it.weight } ?: 0
    if (max <= 0) return rows.map { 0f }
    return rows.map { if (it.weight <= 0) 0f else (it.weight.toFloat() / max).coerceIn(0.02f, 1f) }
}

internal fun purposeLabel(purpose: String): UiText = when (purpose) {
    "chat" -> UiText.Resource(R.string.settings_usage_purpose_chat)
    "memory" -> UiText.Resource(R.string.settings_usage_purpose_memory)
    "title" -> UiText.Resource(R.string.settings_usage_purpose_title)
    "agent_task" -> UiText.Resource(R.string.settings_usage_purpose_agent_task)
    "other" -> UiText.Resource(R.string.settings_usage_purpose_other)
    else -> UiText.Literal(purpose.replace('_', ' ').replaceFirstChar { it.uppercase() })
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
        UsageRow(UiText.Literal(listOfNotNull(it.optionalString("providerName"), it.optionalString("model")).joinToString(" / ")), it.section("usage").usageTotals())
    },
    byAgent = body.objects("byAgent").map {
        val id = it.optionalString("agentId")
        val label = if (id == null) UiText.Resource(R.string.settings_usage_unassigned) else UiText.Literal(agentNames[id] ?: id)
        UsageRow(label, it.section("usage").usageTotals())
    },
    daily = body.objects("daily").map { UsageRow(UiText.Literal(it.string("day")), it.section("usage").usageTotals()) },
    search = (body["search"] as? JsonObject)?.searchUsage(),
)

/** The web's wording for an empty answer: all-time, or the whole of tracking, versus a quiet period. */
internal fun emptyUsageMessage(data: UsageData): UiText = UiText.Resource(
    if (data.period == "all" || data.from == data.trackingSince) R.string.settings_usage_empty_all else R.string.settings_usage_empty_period,
)

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

private val SearchOutcomeRes = mapOf(
    "succeeded" to R.string.settings_usage_outcome_succeeded,
    "empty" to R.string.settings_usage_outcome_empty,
    "failed" to R.string.settings_usage_outcome_failed,
    "skipped" to R.string.settings_usage_outcome_skipped,
)
private val SearchReasonRes = mapOf(
    "not_configured" to R.string.settings_usage_reason_not_configured,
    "rate_limited" to R.string.settings_usage_reason_rate_limited,
    "search_rate_limited" to R.string.settings_usage_reason_rate_limited,
    "timeout" to R.string.settings_usage_reason_timeout,
    "search_timeout" to R.string.settings_usage_reason_timeout,
    "search_failed" to R.string.settings_usage_reason_search_failed,
    "fetch_failed" to R.string.settings_usage_reason_fetch_failed,
)

internal fun searchReason(reason: String): UiText =
    SearchReasonRes[reason]?.let { UiText.Resource(it) } ?: UiText.Literal(reason.replace('_', ' '))

/** `Failed · timed out (as fallback)`, with the number of calls it covers. */
internal fun searchDetailLabel(detail: SearchDetail): UiText {
    val base = SearchOutcomeRes[detail.outcome]?.let { UiText.Resource(it) } ?: UiText.Literal(detail.outcome)
    val withReason = detail.reason?.takeIf { it.isNotEmpty() }?.let {
        UiText.Resource(R.string.settings_usage_detail_with_reason, base, searchReason(it))
    } ?: base
    return if (detail.fallback) UiText.Resource(R.string.settings_usage_detail_fallback, withReason) else withReason
}

/** The mean time a provider took: whole milliseconds with grouping, or a dash when none reached it. */
internal fun averageText(ms: Double?): UiText =
    if (ms == null) UiText.Literal("—")
    else UiText.Resource(R.string.settings_usage_avg_ms, NumberFormat.getNumberInstance(Locale.getDefault()).apply { maximumFractionDigits = 3 }.format(ms))

// ---- the custom range ----

/** A UTC day (`YYYY-MM-DD`) for a moment in time. */
internal fun utcDay(millis: Long): String = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()

/** The start of a UTC day, in milliseconds; null when [day] is not a date. */
internal fun utcDayMillis(day: String): Long? =
    try { LocalDate.parse(day).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() } catch (_: Exception) { null }

/** The range a first look at "Custom range" starts from: the last 30 days, ending today. */
internal fun defaultRange(nowMillis: Long): Pair<String, String> = utcDay(nowMillis - 29 * 86_400_000L) to utcDay(nowMillis)

/** What is wrong with a custom range, in the web's words; null when it can be sent. */
internal fun rangeProblem(from: String, to: String): UiText? = when {
    from.isEmpty() || to.isEmpty() -> UiText.Resource(R.string.settings_usage_range_both)
    from > to -> UiText.Resource(R.string.settings_usage_range_order)
    else -> null
}

/** The request's query: only a custom period carries its dates. */
internal fun usageQuery(period: String, from: String, to: String): Map<String, String> =
    if (period == "custom") mapOf("period" to period, "from" to from, "to" to to) else mapOf("period" to period)

