package dev.rei.android.ui.components.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.data.groupedNumber
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiMotion
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.arrive
import dev.rei.android.ui.theme.tabular

/** In Simple mode a run that is still working shows its latest rows only; expanding by hand shows them all. */
private const val SimpleLiveRows = 5

/**
 * One quiet row for a run ("Worked for 4.4 s") with a chevron. Finished runs stay collapsed; a live run is open. Tapping
 * expands the calls in place: Simple mode as one-line summaries, Detail mode with model calls, timing and Inspect.
 */
@Composable
fun ToolActivityRow(
    run: RunTrace,
    detail: Boolean,
    modifier: Modifier = Modifier,
    outcomes: ApprovalOutcomes = emptyMap(),
    waitingForApproval: Boolean = false,
    onInspect: ((stepId: String) -> Unit)? = null,
    onOpenPage: (pageId: String) -> Unit = {},
    onToggle: ((open: Boolean) -> Unit)? = null,
) {
    val steps = visibleSteps(run, detail)
    if (steps.isEmpty()) return
    // Simple mode: when the run ends the list goes back to its collapsed summary, even if it was opened while it ran.
    var expanded by remember(run.runId, run.live, detail) { mutableStateOf<Boolean?>(null) }
    val open = expanded ?: run.live
    val capped = !detail && run.live && expanded == null
    val shown = if (capped) steps.takeLast(SimpleLiveRows) else steps
    val acted = steps.count { it.sideEffect }
    val context = LocalContext.current
    val heading = activityHeading(run, waitingForApproval).asString()
    val scale = LocalMotionScale.current
    val density = androidx.compose.ui.platform.LocalDensity.current.density
    val collapsedRotation = if (LocalLayoutDirection.current == LayoutDirection.Rtl) 90f else -90f
    val rotation by animateFloatAsState(
        if (open) 0f else collapsedRotation,
        tween(if (scale <= 0f) 0 else (ReiMotion.CeilingMs * 0.5f).toInt()),
        label = "chevron",
    )

    val waitText = if (!run.live && run.approvalWaitMs > 0) {
        stringResource(R.string.chat_activity_waited, duration(run.approvalWaitMs).asString())
    } else null
    val clickActionLabel = stringResource(if (open) R.string.chat_activity_hide else R.string.chat_activity_show)
    val toggleStateDesc = stringResource(if (open) R.string.common_expanded else R.string.common_collapsed)
    Column(modifier.fillMaxWidth().arrive(ReiEnter.Rise), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(onClickLabel = clickActionLabel, role = Role.Button) {
                    val next = !open
                    expanded = next
                    onToggle?.invoke(next)
                }
                .semantics(mergeDescendants = true) {
                    stateDescription = toggleStateDesc
                    contentDescription = if (waitText != null) "$heading. $waitText" else heading
                }
                .padding(horizontal = 4.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(heading, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Icon(
                    ReiIcons.Chevron,
                    contentDescription = null,
                    Modifier.size(18.dp).rotate(rotation),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (waitText != null) {
                Text(
                    waitText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        AnimatedVisibility(open, enter = ReiMotion.enter(ReiEnter.Fade, scale, density), exit = ReiMotion.exit(scale)) {
            Column(Modifier.padding(bottom = 4.dp).testTag("activity-list"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (detail) {
                    val stepsSummary = pluralStringResource(R.plurals.chat_activity_steps, steps.size, steps.size) +
                        if (acted > 0) stringResource(R.string.chat_activity_acted_outside_suffix, acted) else ""
                    Text(
                        stepsSummary,
                        Modifier.padding(start = 4.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Surface(
                        shape = ReiShapes.Inset,
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    ) {
                        Column {
                            shown.forEachIndexed { index, step ->
                                if (index > 0) HorizontalDivider(Modifier.padding(start = 36.dp), color = MaterialTheme.colorScheme.outlineVariant)
                                ActivityRowItem(step, true, outcomes, waitingForApproval, onInspect, onOpenPage)
                            }
                        }
                    }
                } else {
                    Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        val hidden = steps.size - shown.size
                        if (hidden > 0) {
                            Text(
                                pluralStringResource(R.plurals.chat_activity_hidden_steps, hidden, hidden),
                                Modifier.padding(vertical = 2.dp),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        shown.forEach { step -> ActivityRowItem(step, false, outcomes, waitingForApproval, null, onOpenPage) }
                    }
                }
            }
        }
    }
}

/** One step: icon, what it did, and in Detail mode its page or site chips, facts and a chevron into Inspect. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ActivityRowItem(
    step: TraceStep,
    detail: Boolean,
    outcomes: ApprovalOutcomes,
    waitingForApproval: Boolean,
    onInspect: ((String) -> Unit)?,
    onOpenPage: (String) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val label = activityLabel(step).asString()
    val status = activityStatus(step, outcomes, waitingForApproval).asString()
    val decided = decidedWord(step, outcomes)
    val allowed = (decided as? dev.rei.android.ui.UiText.Resource)?.id == R.string.chat_activity_allowed
    val tone = when {
        allowed -> colors.primary
        step.status == "error" -> colors.error
        step.status == "blocked" && decided == null -> colors.onTertiaryContainer
        step.status == "running" -> colors.onSurface
        else -> colors.onSurfaceVariant
    }
    // A model call is the quiet backdrop; a tool call is what the run did, so it reads one step darker.
    val labelColor = if (tone == colors.onSurfaceVariant && step.type != "llm.call") colors.onSurface else tone
    val facts = if (detail) listOfNotNull(
        step.latencyMs?.let { duration(it).asString() },
        step.model?.substringAfterLast('/'),
        step.tokens?.let { stringResource(R.string.chat_activity_tokens, groupedNumber(it)) },
        step.errorCode,
    ) else emptyList()
    val inspectStepLabel = stringResource(R.string.chat_activity_inspect_step)
    val rowDesc = stringResource(R.string.chat_activity_row_desc, label, status)
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .then(if (onInspect != null) Modifier.clickable(onClickLabel = inspectStepLabel, role = Role.Button) { onInspect(step.id) } else Modifier)
                .semantics(mergeDescendants = true) { contentDescription = rowDesc }
                .padding(horizontal = if (detail) 12.dp else 0.dp, vertical = if (detail) 8.dp else 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(activityIcon(step, allowed), contentDescription = null, Modifier.size(16.dp), tint = tone)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = labelColor,
                    maxLines = if (detail) 2 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (facts.isNotEmpty() || (detail && step.sideEffect)) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                        itemVerticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (facts.isNotEmpty()) {
                            Text(facts.joinToString(" · "), style = MaterialTheme.typography.labelMedium.tabular(), color = colors.onSurfaceVariant)
                        }
                        if (step.sideEffect) {
                            Text(
                                stringResource(R.string.chat_activity_acted_outside_chip),
                                Modifier.background(colors.tertiaryContainer, ReiShapes.Pill).padding(horizontal = 8.dp, vertical = 1.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = colors.onTertiaryContainer,
                            )
                        }
                    }
                }
            }
            if (step.status != "ok") Text(status, style = MaterialTheme.typography.labelMedium, color = tone)
            if (onInspect != null) Icon(ReiIcons.Forward, null, Modifier.size(14.dp), tint = colors.onSurfaceVariant)
        }
        if (detail && (step.pageId != null || step.webTitle != null)) {
            FlowRow(
                Modifier.padding(start = 40.dp, end = 12.dp, bottom = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                step.pageId?.let { id -> ChipLabel(ReiIcons.Page, step.pageTitle ?: stringResource(R.string.chat_activity_page)) { onOpenPage(id) } }
                step.webTitle?.let { title -> ChipLabel(ReiIcons.Globe, listOfNotNull(title, step.webHost).joinToString(" · "), null) }
            }
        }
    }
}

@Composable
private fun ChipLabel(icon: ImageVector, text: String, onClick: (() -> Unit)?) {
    Box(
        Modifier
            .then(if (onClick != null) Modifier.heightIn(min = 48.dp).clickable(role = Role.Button, onClick = onClick) else Modifier),
        contentAlignment = Alignment.CenterStart,
    ) {
        Surface(
            shape = ReiShapes.Pill,
            color = Color.Transparent,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(icon, null, Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    text,
                    Modifier.widthIn(max = 260.dp),
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textDecoration = if (onClick != null) TextDecoration.Underline else null,
                )
            }
        }
    }
}

internal fun activityIcon(step: TraceStep, allowed: Boolean = false): ImageVector {
    if (allowed) return ReiIcons.Check
    if (step.status == "error" || step.status == "blocked" || step.status == "not_executed") return ReiIcons.Alert
    if (step.type == "llm.call") return ReiIcons.Sparkle
    if (step.type == "capabilities.changed") return ReiIcons.Puzzle
    val name = step.toolName.orEmpty()
    return when {
        name == "bash" -> ReiIcons.Terminal
        name == "show_surface" || name == "update_surface" -> ReiIcons.Grid
        name == "read" || name == "read_skill_file" || name == "use_skill" -> ReiIcons.Memory
        name == "write" || name == "edit" -> ReiIcons.Edit
        "search" in name -> ReiIcons.Search
        name.startsWith("web_") || name.startsWith("browser_") -> ReiIcons.Globe
        name.endsWith("_session") || name == "list_sessions" -> ReiIcons.Sessions
        name.startsWith("memory_") -> ReiIcons.Memory
        name.startsWith("knowledge_") -> ReiIcons.Knowledge
        else -> ReiIcons.Wrench
    }
}

@ReiPreviews
@Composable
private fun ToolActivityRowPreview() = ReiPreviewSurface {
    ToolActivityRow(
        run = RunTrace(
            runId = "r1",
            status = "completed",
            triggerMessageId = "m1",
            steps = listOf(
                TraceStep(
                    id = "st1",
                    type = "tool.call",
                    status = "completed",
                    startedAt = 0L,
                    latencyMs = 420L,
                    sideEffect = false,
                    toolName = "knowledge_search",
                    decision = "allow",
                    approvalId = null,
                    summary = "Search Q3 notes",
                    activity = "Searching knowledge",
                    pageId = null,
                    pageTitle = null,
                    webTitle = null,
                    webHost = null,
                    model = null,
                    tokens = null,
                    errorCode = null,
                ),
            ),
            durationMs = 1400L,
            approvalWaitMs = 0L,
        ),
        detail = true,
    )
}
