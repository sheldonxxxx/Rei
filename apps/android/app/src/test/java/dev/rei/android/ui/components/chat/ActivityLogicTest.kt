package dev.rei.android.ui.components.chat

import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
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
        assertEquals("Working…", activityHeading(run("running"), waitingForApproval = false))
        assertEquals("Waiting for approval", activityHeading(run("running"), waitingForApproval = true))
        assertEquals("Stopped", activityHeading(run("cancelled"), false))
        assertEquals("Failed after 4.4 s", activityHeading(run("failed"), false))
        assertEquals("Failed", activityHeading(run("failed", durationMs = null), false))
        assertEquals("Interrupted after 4.4 s", activityHeading(run("failed").copy(continued = true), false))
        assertEquals("Worked for 4.4 s", activityHeading(run(), false))
    }

    @Test
    fun timeWaitingForApprovalIsNotWorkTime() {
        assertEquals("Worked for 2.0 s", activityHeading(run(durationMs = 9000, wait = 7000), false))
    }

    @Test
    fun durationsRead() {
        assertEquals("120 ms", duration(120))
        assertEquals("4.4 s", duration(4400))
        assertEquals("35 s", duration(35_000))
        assertEquals("2 min 5 s", duration(125_000))
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
        assertEquals("Needs approval", activityStatus(blocked))
        assertEquals("Allowed", activityStatus(blocked, mapOf("ap1" to "approved")))
        assertEquals("Denied", activityStatus(blocked, mapOf("ap1" to "denied")))
    }

    @Test
    fun labelsPreferTheActivityThenTheSummary() {
        assertEquals("Searching the web", activityLabel(step(activity = " Searching the web ", summary = "x")))
        assertEquals("Looked up x", activityLabel(step(summary = "Looked up x")))
        assertEquals("web search", activityLabel(step()))
        assertEquals("Model call", activityLabel(step(type = "llm.call")))
    }
}
