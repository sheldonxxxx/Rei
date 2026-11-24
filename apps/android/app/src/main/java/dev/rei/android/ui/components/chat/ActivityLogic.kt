package dev.rei.android.ui.components.chat

import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep

/** The same words as the web chat (`apps/web/src/lib/activity.ts` and `trace.ts`), so a run reads the same on both. */

private val SurfaceTools = setOf("show_surface", "update_surface")

/** A surface tool call: its result shows in the reply as the surface itself, so Simple mode draws no row for it. */
fun isSurfaceStep(step: TraceStep): Boolean = step.type == "tool.call" && step.toolName in SurfaceTools

fun activityLabel(step: TraceStep): String {
    if (step.type == "llm.call") return "Model call"
    if (isSurfaceStep(step) && step.status == "error") {
        return if (step.toolName == "show_surface") "A surface was refused and sent back to fix" else "A surface change was refused"
    }
    if (step.type == "capabilities.changed") return "Capabilities changed"
    return step.activity?.trim()?.takeIf(String::isNotEmpty)
        ?: step.summary?.trim()?.takeIf(String::isNotEmpty)
        ?: step.toolName?.replace('_', ' ')
        ?: "Use a tool"
}

/** What became of each approval in the chat, by id, so a blocked step reads "Allowed" rather than "Needs approval". */
typealias ApprovalOutcomes = Map<String, String>

private val DecidedWords = mapOf("approved" to "Allowed", "denied" to "Denied", "expired" to "Expired", "cancelled" to "Cancelled")

fun decidedWord(step: TraceStep, outcomes: ApprovalOutcomes): String? {
    if (step.status != "blocked" || step.decision != "ask" || step.approvalId == null) return null
    return outcomes[step.approvalId]?.let(DecidedWords::get)
}

fun activityStatus(step: TraceStep, outcomes: ApprovalOutcomes = emptyMap(), waitingForApproval: Boolean = false): String {
    decidedWord(step, outcomes)?.let { return it }
    return when (step.status) {
        "running" ->
            if ((waitingForApproval && step.decision == "ask") || (step.approvalId != null && outcomes[step.approvalId] == "pending")) "Waiting for approval"
            else "Running"
        "error" -> "Failed"
        "cancelled" -> "Stopped"
        "not_executed" -> if (step.errorCode == "interrupted") "Interrupted" else "Not run"
        "blocked" -> if (step.decision == "ask") "Needs approval" else "Blocked"
        else -> "Completed"
    }
}

/** "4.4 s", "35 s", "2 min 5 s", "120 ms". */
fun duration(ms: Long?): String {
    if (ms == null) return "…"
    if (ms < 1000) return "$ms ms"
    val s = ms / 1000.0
    if (s < 60) return if (s < 10) "%.1f s".format(java.util.Locale.US, s) else "${Math.round(s)} s"
    val m = (s / 60).toInt()
    return "$m min ${Math.round(s - m * 60)} s"
}

/**
 * The words on the collapsed row: "Working…", "Waiting for approval", "Stopped", "Failed after 4.4 s", "Interrupted after 4.4 s"
 * (a failed run the user went on from) or "Worked for 4.4 s".
 */
fun activityHeading(run: RunTrace, waitingForApproval: Boolean): String {
    if (run.live) return if (waitingForApproval) "Waiting for approval" else "Working…"
    return when (run.status) {
        "cancelled" -> "Stopped"
        "failed" -> {
            val verb = if (run.continued) "Interrupted" else "Failed"
            val lasted = run.durationMs?.let { (it - run.approvalWaitMs).coerceAtLeast(0) }
            if (lasted != null) "$verb after ${duration(lasted)}" else verb
        }
        else -> {
            val worked = run.durationMs?.let { (it - run.approvalWaitMs).coerceAtLeast(0) }
            if (worked != null && (run.status != "cancelled" || run.approvalWaitMs == 0L)) "Worked for ${duration(worked)}" else "Worked"
        }
    }
}

/** The rows a run shows: Simple mode hides model calls and surface calls that worked; Detail mode shows every step. */
fun visibleSteps(run: RunTrace, detail: Boolean): List<TraceStep> =
    if (detail) run.steps else run.steps.filter { it.type == "tool.call" && !(isSurfaceStep(it) && it.status != "error") }
