package dev.rei.android.ui.components.chat

import dev.rei.android.R
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.ui.UiText
import org.junit.Assert.assertEquals
import org.junit.Test

class ActivityLogicTest {
    private fun step(
        id: String = "s",
        type: String = "tool.call",
        status: String = "ok",
        tool: String? = "web_search",
        decision: String? = null,
        approval: String? = null,
        summary: String? = null,
        activity: String? = null,
    ) = TraceStep(
        id, type, status, 0, null, false, tool, decision, approval, summary, activity, null, null, null, null, null, null, null,
    )

    private fun run(status: String = "completed", durationMs: Long? = 4400, wait: Long = 0, steps: List<TraceStep> = listOf(step())) =
        RunTrace("r", status, "m", steps, durationMs, wait)

    @Test
    fun headingsUseTheWebWords() {
        assertEquals(UiText.Resource(R.string.chat_activity_working), activityHeading(run("running"), waitingForApproval = false))
        assertEquals(UiText.Resource(R.string.chat_activity_waiting_approval), activityHeading(run("running"), waitingForApproval = true))
        assertEquals(UiText.Resource(R.string.chat_activity_stopped), activityHeading(run("cancelled"), false))
        assertEquals(UiText.Resource(R.string.chat_activity_failed_after, UiText.Resource(R.string.chat_duration_s_decimal, 4.4)), activityHeading(run("failed"), false))
        assertEquals(UiText.Resource(R.string.chat_activity_failed), activityHeading(run("failed", durationMs = null), false))
        assertEquals(UiText.Resource(R.string.chat_activity_interrupted_after, UiText.Resource(R.string.chat_duration_s_decimal, 4.4)), activityHeading(run("failed").copy(continued = true), false))
        assertEquals(UiText.Resource(R.string.chat_activity_worked_for, UiText.Resource(R.string.chat_duration_s_decimal, 4.4)), activityHeading(run(), false))
    }

    @Test
    fun timeWaitingForApprovalIsNotWorkTime() {
        assertEquals(UiText.Resource(R.string.chat_activity_worked_for, UiText.Resource(R.string.chat_duration_s_decimal, 2.0)), activityHeading(run(durationMs = 9000, wait = 7000), false))
    }

    @Test
    fun durationsRead() {
        assertEquals(UiText.Resource(R.string.chat_duration_ms, 120L), duration(120))
        assertEquals(UiText.Resource(R.string.chat_duration_s_decimal, 4.4), duration(4400))
        assertEquals(UiText.Resource(R.string.chat_duration_s_whole, 35L), duration(35_000))
        assertEquals(UiText.Resource(R.string.chat_duration_min_s, 2, 5L), duration(125_000))
    }

    @Test
    fun simpleModeHidesModelCallsAndWorkingSurfaces() {
        val model = step("a", type = "llm.call", tool = null)
        val surface = step("b", tool = "show_surface")
        val failedSurface = step("c", tool = "show_surface", status = "error")
        val tool = step("d")
        val trace = run(steps = listOf(model, surface, failedSurface, tool))
        assertEquals(listOf("c", "d"), visibleSteps(trace, detail = false).map { it.id })
        assertEquals(listOf("a", "b", "c", "d"), visibleSteps(trace, detail = true).map { it.id })
    }

    @Test
    fun aBlockedStepReadsAsTheDecisionOnceMade() {
        val blocked = step(status = "blocked", decision = "ask", approval = "ap1")
        assertEquals(UiText.Resource(R.string.chat_activity_needs_approval), activityStatus(blocked))
        assertEquals(UiText.Resource(R.string.chat_activity_allowed), activityStatus(blocked, mapOf("ap1" to "approved")))
        assertEquals(UiText.Resource(R.string.chat_activity_denied), activityStatus(blocked, mapOf("ap1" to "denied")))
    }

    @Test
    fun labelsPreferTheActivityThenTheSummary() {
        assertEquals(UiText.Literal("Searching the web"), activityLabel(step(activity = " Searching the web ", summary = "x")))
        assertEquals(UiText.Literal("Looked up x"), activityLabel(step(summary = "Looked up x")))
        assertEquals(UiText.Literal("web search"), activityLabel(step()))
        assertEquals(UiText.Resource(R.string.chat_activity_model_call), activityLabel(step(type = "llm.call")))
    }
}
