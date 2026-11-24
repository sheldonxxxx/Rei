package dev.rei.android.feature.activity

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.rei.android.data.ReiApproval
import dev.rei.android.feature.knowledge.relative
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.ApprovalCard
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.tabular
import kotlinx.coroutines.delay

/** What the screen asks of its host: the live data, and how to decide an approval and open a chat. */
@Stable
class ActivityActions(
    val onRefresh: () -> Unit,
    val onRetry: (FailureRow) -> Unit,
    val onUndo: (MemoryChange) -> Unit,
    val onDecide: suspend (ReiApproval, Boolean, String, Int?) -> ReiApproval,
    val onOpenChat: (String) -> Unit,
    val onDismissError: () -> Unit,
)

/** Background Activity: Needs you, Running and Done, over [ActivityStore]. */
@Composable
fun ActivityScreen(
    store: ActivityStore,
    onDecide: suspend (ReiApproval, Boolean, String, Int?) -> ReiApproval,
    onOpenChat: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by store.state.collectAsStateWithLifecycle()
    val notices = LocalNotices.current
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        notices?.show(notice)
        store.consumeNotice()
    }
    ActivityContent(
        state = state,
        actions = ActivityActions(
            onRefresh = { store.refresh() },
            onRetry = store::retry,
            onUndo = store::undo,
            onDecide = onDecide,
            onOpenChat = onOpenChat,
            onDismissError = store::dismissError,
        ),
        modifier = modifier,
    )
}

/** Stateless Background Activity, so it previews and tests without a store. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityContent(state: ActivityUiState, actions: ActivityActions, modifier: Modifier = Modifier) {
    var segment by rememberSaveable { androidx.compose.runtime.mutableStateOf(ActivitySegment.NeedsYou) }
    val listState = rememberLazyListState()
    val scrolled by remember { derivedStateOf { listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > 0 } }
    val rows = state.feed.rows(segment)
    Column(modifier.fillMaxSize()) {
        ReiTopBar("", scrolledTitle = "Background Activity", scrolled = scrolled)
        PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = actions.onRefresh, modifier = Modifier.weight(1f)) {
            Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.TopCenter) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.widthIn(max = 760.dp).fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                item(key = "header", contentType = "header") {
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(
                            "Background Activity",
                            Modifier.fillMaxWidth().semantics { heading() },
                            style = MaterialTheme.typography.headlineMedium,
                        )
                        Segments(segment, { segment = it }, state.feed)
                        state.error?.let { StatusBanner(it, kind = StatusKind.Error, actionLabel = "Retry", onAction = actions.onRefresh) }
                    }
                }
                if (rows.isEmpty()) {
                    item(key = "empty", contentType = "empty") { if (state.loaded) EmptySegment(segment) else LoadingLine() }
                } else {
                    items(rows, key = { it.key }, contentType = { it::class }) { row -> ActivityRowView(row, state, actions) }
                }
            }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Segments(selected: ActivitySegment, onSelect: (ActivitySegment) -> Unit, feed: ActivityFeed) {
    // At large font sizes three labels no longer fit on one line: drop the check icon and let the label wrap.
    val large = LocalDensity.current.fontScale > 1.3f
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        ActivitySegment.entries.forEachIndexed { index, item ->
            val count = feed.rows(item).size
            val description = if (count > 0) "${item.label}, $count" else item.label
            SegmentedButton(
                selected = selected == item,
                onClick = { onSelect(item) },
                shape = SegmentedButtonDefaults.itemShape(index, ActivitySegment.entries.size),
                modifier = Modifier.fillMaxHeight().semantics { contentDescription = description },
                icon = { if (!large) SegmentedButtonDefaults.Icon(selected == item) },
                label = {
                    if (large) {
                        Text(if (count > 0) "${item.label} $count" else item.label, maxLines = 3, textAlign = TextAlign.Center, style = MaterialTheme.typography.labelLarge.tabular())
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(item.label, maxLines = 1)
                            if (count > 0) Text("$count", style = MaterialTheme.typography.labelLarge.tabular())
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun EmptySegment(segment: ActivitySegment) {
    when (segment) {
        ActivitySegment.NeedsYou -> EmptyState(ReiIcons.Check, "Nothing needs you", body = "Approvals and failed work that need an answer appear here.")
        ActivitySegment.Running -> EmptyState(ReiIcons.Clock, "Nothing running", body = "Reviews and trigger runs in progress appear here.")
        ActivitySegment.Done -> EmptyState(ReiIcons.Activity, "Nothing finished yet", body = "Trigger reports and memory changes appear here once work finishes.")
    }
}

@Composable
private fun LoadingLine() {
    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
    }
}

@Composable
private fun ActivityRowView(row: ActivityRow, state: ActivityUiState, actions: ActivityActions) {
    when (row) {
        is ApprovalRow -> ApprovalCard(
            approval = row.approval,
            onDecide = { approve, length, hours -> actions.onDecide(row.approval, approve, length, hours) },
            agentName = state.agentNames[row.approval.agentId],
        )
        is TakeoverRow -> RowCard(onOpen = { actions.onOpenChat(row.sessionId) }, openLabel = "Open ${row.title}", attention = true) {
            Text("Rei wants you to take over the browser", style = MaterialTheme.typography.titleSmall)
            Supporting(row.title)
        }
        is FailureRow -> RowCard(
            onOpen = row.sessionId?.let { id -> { actions.onOpenChat(id) } },
            openLabel = "Open chat for ${row.title}",
            footer = row.retry?.let {
                {
                    OutlinedButton(
                        onClick = { actions.onRetry(row) },
                        enabled = row.key !in state.busy,
                        modifier = Modifier.padding(start = 8.dp).semantics { contentDescription = "Retry ${row.title}" },
                    ) { Text("Retry") }
                }
            },
        ) {
            Text(row.title, style = MaterialTheme.typography.titleSmall)
            Text(row.detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
        is WaitingRow -> RowCard(onOpen = row.sessionId?.let { id -> { actions.onOpenChat(id) } }, openLabel = "Open chat for ${row.title}") {
            Text(row.title, style = MaterialTheme.typography.titleSmall)
            Supporting("Waiting for your answer")
        }
        is RunningRow -> RowCard(onOpen = row.sessionId?.let { id -> { actions.onOpenChat(id) } }, openLabel = "Open chat for ${row.title}") {
            Text(row.title, style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Supporting(row.detail, Modifier.weight(1f, fill = false))
                if (row.startedAt != null) Elapsed(row.startedAt)
            }
            Progress()
        }
        is ReportRow -> RowCard(onOpen = row.sessionId?.let { id -> { actions.onOpenChat(id) } }, openLabel = "Open chat for ${row.title}") {
            val context = LocalContext.current
            Text(row.title, style = MaterialTheme.typography.titleSmall)
            Text(row.report, style = MaterialTheme.typography.bodyMedium, maxLines = 5, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            Supporting(relative(context, row.at))
        }
        is MemoryReviewRow -> MemoryReviewCard(row, state, actions)
    }
}

@Composable
private fun MemoryReviewCard(row: MemoryReviewRow, state: ActivityUiState, actions: ActivityActions) {
    val context = LocalContext.current
    val job = row.job
    RowCard(
        onOpen = job.sessionId?.let { id -> { actions.onOpenChat(id) } },
        openLabel = "Open chat for ${kindLabel(job.kind)}",
        footer = if (row.changes.isEmpty()) null else {
            {
                row.changes.forEach { change ->
                    Row(Modifier.fillMaxWidth().padding(start = 8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Text(changeText(change), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        when {
                            change.undone -> Supporting("Undone", Modifier.padding(end = 8.dp))
                            change.undoable -> TextButton(
                                onClick = { actions.onUndo(change) },
                                enabled = "change:${change.id}" !in state.busy,
                                modifier = Modifier.semantics { contentDescription = "Undo ${changeText(change)}" },
                            ) { Text("Undo") }
                        }
                    }
                }
            }
        },
    ) {
        Text(kindLabel(job.kind), style = MaterialTheme.typography.titleSmall)
        Supporting(listOfNotNull(job.sessionTitle, job.agentName, relative(context, job.finishedAt ?: job.createdAt)).joinToString(" · "))
        if (job.status == "no_changes") Supporting("No changes")
    }
}

/** What a memory change did, in one line: the new text, or the removed one. */
internal fun changeText(change: MemoryChange): String = when (change.op) {
    "add" -> "Added: ${change.after.orEmpty()}"
    "remove" -> "Removed: ${change.before.orEmpty()}"
    "replace" -> "Changed to: ${change.after.orEmpty()}"
    else -> "Confirmed: ${(change.after ?: change.before).orEmpty()}"
}

/**
 * A card whose [content] opens the chat when it has one. [footer] (buttons) sits outside the touch target, so its own
 * actions stay separate controls for TalkBack.
 */
@Composable
private fun RowCard(
    onOpen: (() -> Unit)?,
    openLabel: String,
    attention: Boolean = false,
    footer: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = ReiShapes.Card,
        color = if (attention) colors.tertiaryContainer else ReiTheme.colors.card,
        contentColor = if (attention) colors.onTertiaryContainer else colors.onSurface,
        border = BorderStroke(1.dp, if (attention) ReiTheme.colors.attentionBorder else colors.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Column(
                Modifier
                    .fillMaxWidth()
                    .then(if (onOpen != null) Modifier.clickable(onClickLabel = openLabel, role = Role.Button, onClick = onOpen) else Modifier)
                    .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = if (footer == null) 16.dp else 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) { content() }
            if (footer != null) Column(Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp)) { footer() }
        }
    }
}

@Composable
private fun Supporting(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Elapsed time that ticks once a second while it is on screen, in tabular figures so the digits do not jitter. */
@Composable
private fun Elapsed(startedAt: Long) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val text = elapsedText(startedAt, now)
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium.tabular(),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.semantics { contentDescription = "Running for $text" },
    )
}

/** An indeterminate line; with animations off (system animator scale 0) it is a still bar. */
@Composable
private fun Progress() {
    val modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
    if (LocalMotionScale.current == 0f) LinearProgressIndicator(progress = { 0.35f }, modifier = modifier)
    else LinearProgressIndicator(modifier = modifier)
}
