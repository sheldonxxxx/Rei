package dev.rei.android.feature.activity

import androidx.annotation.StringRes
import dev.rei.android.R
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** The three filters of Background Activity, in the order they sit in the segmented row. */
enum class ActivitySegment(@StringRes val labelRes: Int) {
    NeedsYou(R.string.activity_segment_needs_you),
    Running(R.string.activity_segment_running),
    Done(R.string.activity_segment_done),
}

/** A background job (today only Memory review) as `GET /api/background` lists it. */
data class BackgroundJob(
    val id: String,
    val kind: String,
    val sessionId: String?,
    val status: String,
    val createdAt: Long,
    val finishedAt: Long?,
    val diagnostic: String?,
    val sessionTitle: String?,
    val agentName: String?,
    val model: String?,
)

data class MemoryChange(
    val id: String,
    val op: String,
    val before: String?,
    val after: String?,
    val undoable: Boolean,
    val undone: Boolean,
)

data class TriggerRun(
    val id: String,
    val status: String,
    val scheduledAt: Long,
    val startedAt: Long?,
    val finishedAt: Long?,
    val reason: String?,
    val sessionId: String?,
    val report: String?,
)

data class TriggerSummary(val id: String, val name: String, val status: String, val lastRun: TriggerRun?)

/** What a failure row's Retry does. */
sealed interface RetryTarget {
    data class Job(val id: String) : RetryTarget
    data class Trigger(val id: String) : RetryTarget
}

/** One row of the list. [key] is stable across refreshes so the list keeps its place. */
sealed interface ActivityRow {
    val key: String
    /** The chat the row opens, when it has one. */
    val sessionId: String?
}

data class ApprovalRow(val approval: ReiApproval) : ActivityRow {
    override val key get() = "approval:${approval.id}"
    override val sessionId get() = approval.sessionId
}

data class TakeoverRow(override val sessionId: String, val title: UiText) : ActivityRow {
    override val key get() = "takeover:$sessionId"
}

data class FailureRow(
    override val key: String,
    val title: UiText,
    val detail: UiText,
    override val sessionId: String?,
    val retry: RetryTarget?,
) : ActivityRow

/** A trigger run waiting for an answer that is not an approval card (it waits on you in its chat). */
data class WaitingRow(override val key: String, val title: String, override val sessionId: String?) : ActivityRow

data class RunningRow(
    override val key: String,
    val title: UiText,
    val detail: UiText,
    /** When the work began, for the elapsed time; null while it is only queued. */
    val startedAt: Long?,
    override val sessionId: String?,
) : ActivityRow

data class ReportRow(
    override val key: String,
    val title: String,
    val report: String,
    val at: Long,
    override val sessionId: String?,
) : ActivityRow

data class MemoryReviewRow(val job: BackgroundJob, val changes: List<MemoryChange>) : ActivityRow {
    override val key get() = "review:${job.id}"
    override val sessionId get() = job.sessionId
}

data class ActivityFeed(
    val needs: List<ActivityRow> = emptyList(),
    val running: List<ActivityRow> = emptyList(),
    val done: List<ActivityRow> = emptyList(),
) {
    fun rows(segment: ActivitySegment) = when (segment) {
        ActivitySegment.NeedsYou -> needs
        ActivitySegment.Running -> running
        ActivitySegment.Done -> done
    }

    /** The drawer badge: everything in Needs you. */
    val needsCount get() = needs.size
}

/** Failures older than this stop asking for attention; the web page keeps the full history. */
const val FailureWindowMs = 7L * 24 * 60 * 60 * 1000

/** How many finished reviews show on Done, and for how many of them the changes are fetched. */
const val DoneReviews = 10
const val ReviewsWithChanges = 5

fun kindLabel(kind: String): UiText = if (kind == "memory.review") {
    UiText.Resource(R.string.activity_kind_memory_review)
} else {
    UiText.Literal(kind.replace('.', ' ').replace('_', ' ').replaceFirstChar { it.uppercase() })
}

/**
 * Sorts what the server and the live stream know into the three segments.
 * - **Needs you:** pending approvals (oldest first), browser takeovers, failed jobs and failed trigger runs from the last week
 *   (newest first, with Retry), and trigger runs waiting on you with no approval card in their chat.
 * - **Running:** queued or running jobs and trigger runs.
 * - **Done:** trigger reports and finished Memory reviews with their changes.
 */
fun buildActivity(
    approvals: List<ReiApproval>,
    takeoverSessionIds: Set<String>,
    sessionTitles: Map<String, String>,
    jobs: List<BackgroundJob>,
    triggers: List<TriggerSummary>,
    changes: Map<String, List<MemoryChange>>,
    now: Long,
): ActivityFeed {
    val pending = approvals.filter { it.status == "pending" }
    val approvalSessions = pending.map { it.sessionId }.toSet()
    val recent = now - FailureWindowMs
    val needs = buildList {
        pending.forEach { add(ApprovalRow(it)) }
        takeoverSessionIds.sorted().forEach {
            val title = sessionTitles[it]?.let(UiText::Literal) ?: UiText.Resource(R.string.chat_title)
            add(TakeoverRow(it, title))
        }
        val failures = buildList<Pair<Long, ActivityRow>> {
            jobs.filter { it.status == "failed" && (it.finishedAt ?: it.createdAt) >= recent }.forEach { job ->
                add((job.finishedAt ?: job.createdAt) to FailureRow(
                    key = "job:${job.id}",
                    title = kindLabel(job.kind),
                    detail = job.diagnostic?.takeIf { it.isNotBlank() }?.let(UiText::Literal) ?: UiText.Resource(R.string.activity_err_review_failed),
                    sessionId = job.sessionId,
                    retry = RetryTarget.Job(job.id),
                ))
            }
            triggers.forEach { trigger ->
                val run = trigger.lastRun ?: return@forEach
                val at = run.finishedAt ?: run.scheduledAt
                if (run.status == "failed" && at >= recent) add(at to FailureRow(
                    key = "run:${run.id}",
                    title = UiText.Literal(trigger.name),
                    detail = run.reason?.takeIf { it.isNotBlank() }?.let(UiText::Literal) ?: UiText.Resource(R.string.activity_err_run_failed),
                    sessionId = run.sessionId,
                    retry = RetryTarget.Trigger(trigger.id).takeIf { trigger.status == "active" },
                ))
            }
        }
        failures.sortedByDescending { it.first }.forEach { add(it.second) }
        triggers.forEach { trigger ->
            val run = trigger.lastRun ?: return@forEach
            if (run.status == "waiting" && run.sessionId !in approvalSessions && run.sessionId !in takeoverSessionIds) {
                add(WaitingRow("run:${run.id}", trigger.name, run.sessionId))
            }
        }
    }
    val running = buildList {
        jobs.filter { it.status == "running" || it.status == "queued" }.forEach { job ->
            val detail = job.sessionTitle?.let(UiText::Literal) ?: UiText.Resource(
                if (job.status == "queued") R.string.activity_status_queued else R.string.activity_status_working,
            )
            add(RunningRow(
                key = "job:${job.id}",
                title = kindLabel(job.kind),
                detail = detail,
                startedAt = job.createdAt.takeIf { job.status == "running" },
                sessionId = job.sessionId,
            ))
        }
        triggers.forEach { trigger ->
            val run = trigger.lastRun ?: return@forEach
            if (run.status == "running" || run.status == "queued") add(RunningRow(
                key = "run:${run.id}",
                title = UiText.Literal(trigger.name),
                detail = UiText.Resource(if (run.status == "queued") R.string.activity_status_queued else R.string.activity_status_trigger_run),
                startedAt = run.startedAt.takeIf { run.status == "running" },
                sessionId = run.sessionId,
            ))
        }
    }
    val reports = triggers.mapNotNull { trigger ->
        val run = trigger.lastRun ?: return@mapNotNull null
        val text = run.report?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        if (run.status != "succeeded") return@mapNotNull null
        (run.finishedAt ?: run.scheduledAt) to ReportRow("run:${run.id}", trigger.name, text, run.finishedAt ?: run.scheduledAt, run.sessionId)
    }
    val reviews = jobs.filter { it.status == "succeeded" || it.status == "no_changes" }
        .sortedByDescending { it.finishedAt ?: it.createdAt }
        .take(DoneReviews)
        .map { (it.finishedAt ?: it.createdAt) to MemoryReviewRow(it, changes[it.id].orEmpty()) }
    val done = (reports + reviews).sortedByDescending { it.first }.map { it.second }
    return ActivityFeed(needs, running, done)
}

/** `2:05` under an hour, `1:02:05` over: the elapsed time of running work. */
fun elapsedText(startedAt: Long, now: Long): String {
    val seconds = ((now - startedAt) / 1000).coerceAtLeast(0)
    val h = seconds / 3600
    val m = seconds % 3600 / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

// ---- parsing ------------------------------------------------------------------------------------------------------

private fun JsonObject.long(key: String): Long? = this[key]?.takeUnless { it == JsonNull }?.jsonPrimitive?.longOrNull

fun parseJobs(body: JsonObject): List<BackgroundJob> = body.objects("jobs").map { job ->
    val summary = job["summary"] as? JsonObject
    BackgroundJob(
        id = job.string("id"),
        kind = job.string("kind"),
        sessionId = job.optionalString("session_id"),
        status = job.string("status"),
        createdAt = job.long("created_at") ?: 0,
        finishedAt = job.long("finished_at"),
        diagnostic = job.optionalString("diagnostic"),
        sessionTitle = summary?.optionalString("sessionTitle"),
        agentName = summary?.optionalString("agentName"),
        model = summary?.optionalString("model"),
    )
}

fun parseMemoryChanges(array: List<JsonObject>): List<MemoryChange> = array.map {
    MemoryChange(
        id = it.string("id"),
        op = it.string("op"),
        before = it.optionalString("before"),
        after = it.optionalString("after"),
        undoable = it["undoable"]?.jsonPrimitive?.booleanOrNull == true,
        undone = it.long("undoneAt") != null,
    )
}

fun parseTriggers(body: JsonObject): List<TriggerSummary> = body.objects("triggers").map { trigger ->
    TriggerSummary(trigger.string("id"), trigger.string("name"), trigger.string("status"), (trigger["lastRun"] as? JsonObject)?.let(::parseRun))
}

fun parseRun(run: JsonObject) = TriggerRun(
    id = run.string("id"),
    status = run.string("status"),
    scheduledAt = run.long("scheduledAt") ?: 0,
    startedAt = run.long("startedAt"),
    finishedAt = run.long("finishedAt"),
    reason = run.optionalString("reason"),
    sessionId = run.optionalString("sessionId"),
    report = run.optionalString("report"),
)
