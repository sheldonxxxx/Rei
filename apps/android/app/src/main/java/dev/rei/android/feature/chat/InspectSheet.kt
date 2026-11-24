package dev.rei.android.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.data.groupedNumber
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.chat.ActivityRowItem
import dev.rei.android.ui.components.chat.activityHeading
import dev.rei.android.ui.components.chat.duration
import dev.rei.android.ui.theme.ReiShapes

/** What to inspect: one run (the reply's run), a single step, or everything the chat has recorded. */
data class InspectTarget(val runId: String? = null, val stepId: String? = null)

private const val MaxRuns = 8

private fun runStatus(run: RunTrace) = when (run.status) {
    "queued" -> "Queued"
    "running" -> "Running"
    "completed" -> "Finished"
    "failed" -> "Failed"
    "cancelled" -> "Cancelled"
    else -> run.status
}

/**
 * Inspect, as the web's Inspector: each run with its status, duration and totals, its steps as rows, and one step in full.
 * A sheet on every size for now (the spec allows a pane beside the chat on wide screens once there is room for it).
 */
@Composable
fun InspectSheet(
    api: ReiApi,
    runs: List<RunTrace>,
    target: InspectTarget,
    onDismiss: () -> Unit,
    /** Approval id to the id of its message in the chat, for the loaded messages. */
    approvalMessages: Map<String, String> = emptyMap(),
    onOpenApproval: (messageId: String) -> Unit = {},
) {
    var step by remember(target) { mutableStateOf<TraceStep?>(runs.flatMap { it.steps }.firstOrNull { it.id == target.stepId }) }
    val shown = runs.filter { target.runId == null || it.runId == target.runId }.reversed().take(MaxRuns)
    ReiSheet(onDismiss = onDismiss, title = "Inspect") {
        val selected = step
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
            when {
                selected != null -> StepDetail(
                    api,
                    selected,
                    onBack = { step = null },
                    onOpenStep = { id -> runs.flatMap { it.steps }.firstOrNull { it.id == id }?.let { step = it } },
                    onOpenApproval = selected.approvalId?.let { approval -> approvalMessages[approval] }?.let { message ->
                        { onDismiss(); onOpenApproval(message) }
                    },
                )
                shown.isEmpty() -> Text(
                    "Nothing has been recorded for this reply yet.",
                    Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    shown.forEachIndexed { index, run -> RunView(run, latest = index == 0 && target.runId == null, onOpenStep = { step = it }) }
                }
            }
        }
    }
}

@Composable
private fun RunView(run: RunTrace, latest: Boolean, onOpenStep: (TraceStep) -> Unit) {
    val models = run.steps.count { it.type == "llm.call" }
    val tools = run.steps.count { it.type == "tool.call" }
    val tokens = run.steps.sumOf { it.tokens ?: 0 }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            (if (latest) "Latest · " else "") + activityHeading(run, waitingForApproval = false),
            Modifier.padding(start = 4.dp),
            style = MaterialTheme.typography.titleSmall,
        )
        Surface(
            shape = ReiShapes.Card,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Facts(
                buildList {
                    add("Status" to runStatus(run))
                    add("Duration" to duration(run.durationMs))
                    add(
                        "Totals" to "$models model ${if (models == 1) "call" else "calls"} · $tools tool ${if (tools == 1) "call" else "calls"} · ${groupedNumber(tokens)} tokens",
                    )
                },
                Modifier.padding(14.dp),
            )
        }
        SectionLabel("Steps · ${run.steps.size}")
        if (run.steps.isEmpty()) {
            Text("No steps recorded for this run.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Surface(
                shape = ReiShapes.Inset,
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Column {
                    run.steps.forEachIndexed { index, s ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 36.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        ActivityRowItem(s, detail = true, outcomes = emptyMap(), waitingForApproval = false, onInspect = { onOpenStep(s) }, onOpenPage = {})
                    }
                }
            }
        }
    }
}
