package dev.rei.android.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.data.groupedNumber
import dev.rei.android.ui.components.LocalWorkspaceOpener
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.chat.ActivityRowItem
import dev.rei.android.ui.components.chat.activityHeading
import dev.rei.android.ui.components.chat.duration
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

/** What to inspect: one run (the reply's run), a single step, or everything the chat has recorded. */
data class InspectTarget(val runId: String? = null, val stepId: String? = null)

private const val MaxRuns = 8

@Composable
private fun runStatus(run: RunTrace) = when (run.status) {
    "queued" -> stringResource(R.string.chat_run_queued)
    "running" -> stringResource(R.string.chat_run_running)
    "completed" -> stringResource(R.string.chat_run_finished)
    "failed" -> stringResource(R.string.chat_run_failed)
    "cancelled" -> stringResource(R.string.chat_run_cancelled)
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
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.chat_inspect_title)) {
        InspectBody(
            api = api,
            runs = runs,
            target = target,
            onClose = onDismiss,
            approvalMessages = approvalMessages,
            onOpenApproval = onOpenApproval,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

/** Side-pane Inspect used alongside the chat on expanded (`>=840dp`) tablet screens. */
@Composable
fun InspectPane(
    api: ReiApi,
    runs: List<RunTrace>,
    target: InspectTarget,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    approvalMessages: Map<String, String> = emptyMap(),
    onOpenApproval: (messageId: String) -> Unit = {},
) {
    Surface(
        modifier = modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(stringResource(R.string.chat_inspect_title), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                ReiIconButton(ReiIcons.Close, stringResource(R.string.chat_inspect_close), onDismiss)
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            InspectBody(
                api = api,
                runs = runs,
                target = target,
                onClose = {},
                approvalMessages = approvalMessages,
                onOpenApproval = onOpenApproval,
                modifier = Modifier.weight(1f).padding(top = 12.dp),
            )
        }
    }
}

@Composable
private fun InspectBody(
    api: ReiApi,
    runs: List<RunTrace>,
    target: InspectTarget,
    onClose: () -> Unit,
    approvalMessages: Map<String, String>,
    onOpenApproval: (messageId: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var step by remember(target) { mutableStateOf<TraceStep?>(runs.flatMap { it.steps }.firstOrNull { it.id == target.stepId }) }
    val opener = LocalWorkspaceOpener.current
    val shown = runs.filter { target.runId == null || it.runId == target.runId }.reversed().take(MaxRuns)
    val selected = step
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
        when {
            selected != null -> StepDetail(
                api,
                selected,
                onBack = { step = null },
                onOpenStep = { id -> runs.flatMap { it.steps }.firstOrNull { it.id == id }?.let { step = it } },
                onOpenApproval = selected.approvalId?.let { approval -> approvalMessages[approval] }?.let { message ->
                    { onClose(); onOpenApproval(message) }
                },
            )
            shown.isEmpty() -> Text(
                stringResource(R.string.chat_inspect_empty),
                Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                shown.forEachIndexed { index, run ->
                    RunView(
                        run,
                        latest = index == 0 && target.runId == null,
                        onOpenStep = { step = it },
                        onOpenPage = { pageId -> onClose(); opener?.openPage(pageId) },
                    )
                }
            }
        }
    }
}

@Composable
private fun RunView(run: RunTrace, latest: Boolean, onOpenStep: (TraceStep) -> Unit, onOpenPage: (String) -> Unit) {
    val models = run.steps.count { it.type == "llm.call" }
    val tools = run.steps.count { it.type == "tool.call" }
    val tokens = run.steps.sumOf { it.tokens ?: 0 }
    val heading = activityHeading(run, waitingForApproval = false).asString()
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            if (latest) stringResource(R.string.chat_inspect_latest, heading) else heading,
            Modifier.padding(start = 4.dp),
            style = MaterialTheme.typography.titleSmall,
        )
        Surface(
            shape = ReiShapes.Card,
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            val statusText = runStatus(run)
            val durationText = duration(run.durationMs).asString()
            val modelsText = pluralStringResource(R.plurals.chat_inspect_model_calls, models, models)
            val toolsText = pluralStringResource(R.plurals.chat_inspect_tool_calls, tools, tools)
            val totalsText = stringResource(R.string.chat_inspect_totals_value, modelsText, toolsText, groupedNumber(tokens))
            Facts(
                listOf(
                    stringResource(R.string.chat_inspect_status) to statusText,
                    stringResource(R.string.chat_inspect_duration) to durationText,
                    stringResource(R.string.chat_inspect_totals) to totalsText,
                ),
                Modifier.padding(14.dp),
            )
        }
        SectionLabel(stringResource(R.string.chat_inspect_steps_header, run.steps.size))
        if (run.steps.isEmpty()) {
            Text(stringResource(R.string.chat_inspect_no_steps), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Surface(
                shape = ReiShapes.Inset,
                color = MaterialTheme.colorScheme.surfaceContainerLow,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Column {
                    run.steps.forEachIndexed { index, s ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 36.dp), color = MaterialTheme.colorScheme.outlineVariant)
                        ActivityRowItem(s, detail = true, outcomes = emptyMap(), waitingForApproval = false, onInspect = { onOpenStep(s) }, onOpenPage = onOpenPage)
                    }
                }
            }
        }
    }
}
