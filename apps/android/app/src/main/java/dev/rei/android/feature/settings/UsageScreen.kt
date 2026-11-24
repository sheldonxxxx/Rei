package dev.rei.android.feature.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.tabular

/**
 * Usage: what the models and web search used, for a period. The headline is the tokens processed; below it the input and output
 * figures, then each breakdown (purpose, model, agent, day) as a card whose bars show each row's share of the largest. Figures use
 * the web's K, M and B abbreviations and tabular numerals; a "≥" marks a total that has unreported calls.
 */
@Composable
fun UsageScreen(api: ReiApi, onBack: () -> Unit) {
    var period by rememberSaveable { mutableStateOf("30d") }
    val initial = remember { defaultRange(System.currentTimeMillis()) }
    var from by rememberSaveable { mutableStateOf(initial.first) }
    var to by rememberSaveable { mutableStateOf(initial.second) }
    val problem = if (period == "custom") rangeProblem(from, to) else null
    val agents = rememberResource(api) {
        suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").associate { it.string("id") to it.string("name") } }.getOrDefault(emptyMap())
    }
    val usage = rememberResource(Triple(period, from.takeIf { period == "custom" }, to.takeIf { period == "custom" })) {
        if (problem != null) null
        else usageData(api.request("GET", listOf("api", "usage"), query = usageQuery(period, from, to)), agents.value.orEmpty())
    }
    SubScreen("Usage", onBack, busy = usage.loading, error = usage.error, onRetry = usage::reload) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            UsagePeriods.forEach { (value, label) -> FilterChip(period == value, { period = value }, { Text(label) }) }
        }
        if (period == "custom") {
            RangePicker(from, to, { from = it }, { to = it })
            if (problem != null) StatusBanner(problem, kind = StatusKind.Attention)
        }
        val data = usage.value
        when {
            problem != null -> Unit
            data == null -> if (usage.error == null) Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                androidx.compose.material3.CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            }
            else -> UsageContent(data)
        }
    }
}

@Composable
private fun UsageContent(data: UsageData) {
    Text(
        "${data.from} to ${data.to} · UTC" + if (data.trackingSince.isNotEmpty()) "\nSince ${data.trackingSince} (UTC)" else "",
        style = MaterialTheme.typography.bodyMedium.tabular(), color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    val totals = data.summary
    if (totals.calls == 0L) {
        EmptyState(ReiIcons.Usage, emptyUsageMessage(data))
    } else {
        Headline(totals)
        StatPairs(
            listOf(
                "Total input" to totals.inputTotal.text, "Output" to totals.outputTotal.text,
                "Cached input" to totals.inputCached.text, "Uncached input" to totals.inputUncached.text,
                "Cache hit" to cacheHitText(totals.cacheHitPercent), "Model calls" to compactCount(totals.calls),
            ),
        )
        if (totals.callsUnreported > 0) {
            StatusBanner("${compactCount(totals.callsUnreported)} calls with missing or unreliable reports. Totals count only calls with reliable reports.")
        }
        Breakdown("By purpose", data.byPurpose, cacheHit = false)
        Breakdown("By model", data.byModel, cacheHit = true)
        Breakdown("By agent", data.byAgent, cacheHit = false)
        Breakdown("By day", data.daily, cacheHit = false)
    }
    data.search?.takeIf { it.searches > 0 || it.providers.isNotEmpty() }?.let { SearchSection(it) }
    if (totals.calls > 0) {
        Text(
            "Input includes cached input. Output includes reasoning tokens. “Unavailable” means no reliable report, and “≥” means some calls did not report that figure. Cache hit counts only calls that reported both input and cached tokens. Counters persist regardless of detailed log expiration.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The headline: tokens processed, large, with calls and the cached share of input as a bar. */
@Composable
private fun Headline(totals: UsageTotals) {
    val colors = MaterialTheme.colorScheme
    Surface(shape = ReiShapes.Card, color = ReiTheme.colors.card, border = BorderStroke(1.dp, colors.outlineVariant), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Total processed", style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant)
            Text(totals.totalProcessed.text, style = MaterialTheme.typography.displayMedium.tabular(), color = colors.onSurface)
            Text(
                "${compactCount(totals.calls)} ${if (totals.calls == 1L) "call" else "calls"}",
                style = MaterialTheme.typography.bodyMedium.tabular(), color = colors.onSurfaceVariant,
            )
            val input = totals.inputTotal.value
            val cached = totals.inputCached.value
            if (input != null && cached != null && input > 0) {
                Bar((cached.toFloat() / input).coerceIn(0f, 1f), Modifier.padding(top = 8.dp))
                Text(
                    "${totals.inputCached.text} of ${totals.inputTotal.text} input tokens came from the prompt cache",
                    style = MaterialTheme.typography.bodySmall.tabular(), color = colors.onSurfaceVariant,
                )
            }
        }
    }
}

/** Figures in two columns of equal cards. */
@Composable
private fun StatPairs(stats: List<Pair<String, String>>) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        stats.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { (label, value) -> StatCard(label, value, Modifier.weight(1f)) }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Surface(shape = ReiShapes.Card, color = ReiTheme.colors.card, border = BorderStroke(1.dp, colors.outlineVariant), modifier = modifier) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleLarge.tabular(), color = colors.onSurface)
        }
    }
}

/** A proportion bar: decorative, since the figures beside it carry the same numbers as text. */
@Composable
private fun Bar(fraction: Float, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Box(modifier.fillMaxWidth().height(6.dp).clip(ReiShapes.Pill).background(colors.surfaceContainerHighest).clearAndSetSemantics { }) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().clip(ReiShapes.Pill).background(colors.primary))
    }
}

/** One breakdown as a card: each row names what it covers, its tokens processed, a bar against the largest row, and the detail. */
@Composable
private fun Breakdown(title: String, rows: List<UsageRow>, cacheHit: Boolean) {
    if (rows.isEmpty()) return
    val bars = shares(rows)
    SettingsGroup(title = title) {
        rows.forEachIndexed { index, row ->
            val totals = row.totals
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(row.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
                    Text(totals.totalProcessed.text, style = MaterialTheme.typography.titleMedium.tabular().copy(fontWeight = FontWeight.SemiBold))
                }
                Bar(bars[index])
                Text(
                    listOfNotNull(
                        "Input ${totals.inputTotal.text}", "Cached ${totals.inputCached.text}",
                        "Cache hit ${cacheHitText(totals.cacheHitPercent)}".takeIf { cacheHit },
                        "Output ${totals.outputTotal.text}", "${compactCount(totals.calls)} ${if (totals.calls == 1L) "call" else "calls"}",
                    ).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall.tabular(), color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (index < rows.lastIndex) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable
private fun SearchSection(search: SearchUsage) {
    Text("Web search", Modifier.padding(start = 4.dp).semantics { contentDescription = "Web search usage" }, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (search.searches == 0L) {
        EmptyState(ReiIcons.Globe, "No web searches in this period")
        return
    }
    StatPairs(
        listOf(
            "Searches" to compactCount(search.searches), "Answered" to compactCount(search.answered),
            "No results" to compactCount(search.empty), "Failed" to compactCount(search.failed),
            "Used fallback" to compactCount(search.withFallback),
        ),
    )
    if (search.providers.isNotEmpty()) SettingsGroup(title = "By provider") {
        search.providers.forEachIndexed { index, provider -> ProviderRow(provider, dividerBelow = index < search.providers.lastIndex) }
    }
}

/** One search provider: how its attempts ended and how long they took; a tap shows every counter and the reasons attempts did not answer. */
@Composable
private fun ProviderRow(provider: SearchProvider, dividerBelow: Boolean) {
    var open by rememberSaveable(provider.name) { mutableStateOf(false) }
    SettingsRow(
        provider.name,
        summary = "${compactCount(provider.searched)} searched · ${compactCount(provider.succeeded)} succeeded · ${compactCount(provider.failed)} failed\nAverage ${averageText(provider.averageMs)}",
        onClick = { open = !open }, tabularSummary = true, dividerBelow = dividerBelow || open,
        trailing = { SettingsChevron() },
    )
    if (open) {
        val stats = listOf(
            "Succeeded" to provider.succeeded, "Empty result" to provider.empty, "Failed" to provider.failed,
            "Skipped" to provider.skipped, "Asked as fallback" to provider.fallback, "Answered as fallback" to provider.answeredAfterFallback,
        )
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            stats.forEach { (label, value) ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(compactCount(value), style = MaterialTheme.typography.bodyMedium.tabular())
                }
            }
            provider.problems.forEach { detail ->
                Text("${searchDetailLabel(detail)}: ${compactCount(detail.calls)}", style = MaterialTheme.typography.bodySmall.tabular(), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (dividerBelow) HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** From and To as two rows that open a date picker. Days are UTC; nothing after today can be chosen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RangePicker(from: String, to: String, onFrom: (String) -> Unit, onTo: (String) -> Unit) {
    var picking by remember { mutableStateOf<String?>(null) }
    SettingsGroup {
        SettingsRow("From", summary = from.ifEmpty { "Choose a date" }, onClick = { picking = "from" }, tabularSummary = true, dividerBelow = true, trailing = { SettingsChevron() })
        SettingsRow("To", summary = to.ifEmpty { "Choose a date" }, onClick = { picking = "to" }, tabularSummary = true, trailing = { SettingsChevron() })
    }
    val which = picking ?: return
    val today = remember { utcDayMillis(utcDay(System.currentTimeMillis())) ?: Long.MAX_VALUE }
    val state = rememberDatePickerState(
        initialSelectedDateMillis = utcDayMillis(if (which == "from") from else to),
        selectableDates = object : SelectableDates { override fun isSelectableDate(utcTimeMillis: Long) = utcTimeMillis <= today },
    )
    DatePickerDialog(
        onDismissRequest = { picking = null },
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { millis -> if (which == "from") onFrom(utcDay(millis)) else onTo(utcDay(millis)) }
                picking = null
            }) { Text("Choose") }
        },
        dismissButton = { TextButton(onClick = { picking = null }) { Text("Cancel") } },
    ) { DatePicker(state) }
}
