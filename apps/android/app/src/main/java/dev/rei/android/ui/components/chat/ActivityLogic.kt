package dev.rei.android.ui.components.chat

import dev.rei.android.R
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.ui.UiText

/** The same words as the web chat (`apps/web/src/lib/activity.ts` and `trace.ts`), so a run reads the same on both. */

private val SurfaceTools = setOf("show_surface", "update_surface")

/** A surface tool call: its result shows in the reply as the surface itself, so Simple mode draws no row for it. */
fun isSurfaceStep(step: TraceStep): Boolean = step.type == "tool.call" && step.toolName in SurfaceTools

fun activityLabel(step: TraceStep): UiText {
    if (step.type == "llm.call") return UiText.Resource(R.string.chat_activity_model_call)
    if (isSurfaceStep(step) && step.status == "error") {
        return UiText.Resource(
            if (step.toolName == "show_surface") R.string.chat_activity_surface_refused
            else R.string.chat_activity_surface_update_refused,
        )
    }
    if (step.type == "capabilities.changed") return UiText.Resource(R.string.chat_activity_capabilities_changed)
    return step.activity?.trim()?.takeIf(String::isNotEmpty)?.let(UiText::Literal)
        ?: step.summary?.trim()?.takeIf(String::isNotEmpty)?.let(UiText::Literal)
        ?: step.toolName?.replace('_', ' ')?.let(UiText::Literal)
        ?: UiText.Resource(R.string.chat_activity_use_tool)
}

/** What became of each approval in the chat, by id, so a blocked step reads "Allowed" rather than "Needs approval". */
typealias ApprovalOutcomes = Map<String, String>

private val DecidedWordRes = mapOf(
    "approved" to R.string.chat_activity_allowed,
    "denied" to R.string.chat_activity_denied,
    "expired" to R.string.chat_activity_expired,
    "cancelled" to R.string.chat_activity_cancelled,
)

fun decidedWord(step: TraceStep, outcomes: ApprovalOutcomes): UiText? {
    if (step.status != "blocked" || step.decision != "ask" || step.approvalId == null) return null
    return outcomes[step.approvalId]?.let(DecidedWordRes::get)?.let { UiText.Resource(it) }
}

fun activityStatus(step: TraceStep, outcomes: ApprovalOutcomes = emptyMap(), waitingForApproval: Boolean = false): UiText {
    decidedWord(step, outcomes)?.let { return it }
    return UiText.Resource(
        when (step.status) {
            "running" ->
                if ((waitingForApproval && step.decision == "ask") || (step.approvalId != null && outcomes[step.approvalId] == "pending")) {
                    R.string.chat_activity_waiting_approval
                } else {
                    R.string.chat_activity_running
                }
            "error" -> R.string.chat_activity_failed
            "cancelled" -> R.string.chat_activity_stopped
            "not_executed" -> if (step.errorCode == "interrupted") R.string.chat_activity_interrupted else R.string.chat_activity_not_run
            "blocked" -> if (step.decision == "ask") R.string.chat_activity_needs_approval else R.string.chat_activity_blocked
            else -> R.string.chat_activity_completed
        },
    )
}

/** "4.4 s", "35 s", "2 min 5 s", "120 ms". */
fun duration(ms: Long?): UiText {
    if (ms == null) return UiText.Literal("…")
    if (ms < 1000) return UiText.Resource(R.string.chat_duration_ms, ms)
    val s = ms / 1000.0
    if (s < 60) {
        return if (s < 10) UiText.Resource(R.string.chat_duration_s_decimal, s)
        else UiText.Resource(R.string.chat_duration_s_whole, Math.round(s))
    }
    val m = (s / 60).toInt()
    return UiText.Resource(R.string.chat_duration_min_s, m, Math.round(s - m * 60))
}

/**
 * The words on the collapsed row: "Working…", "Waiting for approval", "Stopped", "Failed after 4.4 s", "Interrupted after 4.4 s"
 * (a failed run the user went on from) or "Worked for 4.4 s".
 */
fun activityHeading(run: RunTrace, waitingForApproval: Boolean): UiText {
    if (run.live) {
        return UiText.Resource(if (waitingForApproval) R.string.chat_activity_waiting_approval else R.string.chat_activity_working)
    }
    return when (run.status) {
        "cancelled" -> UiText.Resource(R.string.chat_activity_stopped)
        "failed" -> {
            val lasted = run.durationMs?.let { (it - run.approvalWaitMs).coerceAtLeast(0) }
            when {
                lasted != null && run.continued -> UiText.Resource(R.string.chat_activity_interrupted_after, duration(lasted))
                lasted != null -> UiText.Resource(R.string.chat_activity_failed_after, duration(lasted))
                run.continued -> UiText.Resource(R.string.chat_activity_interrupted)
                else -> UiText.Resource(R.string.chat_activity_failed)
            }
        }
        else -> {
            val worked = run.durationMs?.let { (it - run.approvalWaitMs).coerceAtLeast(0) }
            if (worked != null && (run.status != "cancelled" || run.approvalWaitMs == 0L)) {
                UiText.Resource(R.string.chat_activity_worked_for, duration(worked))
            } else {
                UiText.Resource(R.string.chat_activity_worked)
            }
        }
    }
}

/** The rows a run shows: Simple mode hides model calls and surface calls that worked; Detail mode shows every step. */
fun visibleSteps(run: RunTrace, detail: Boolean): List<TraceStep> =
    if (detail) run.steps else run.steps.filter { it.type == "tool.call" && !(isSurfaceStep(it) && it.status != "error") }
