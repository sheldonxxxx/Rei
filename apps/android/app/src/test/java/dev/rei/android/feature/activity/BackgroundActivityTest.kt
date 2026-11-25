package dev.rei.android.feature.activity

import dev.rei.android.R
import dev.rei.android.data.ReiApproval
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundActivityTest {
    private val now = 10L * 24 * 60 * 60 * 1000

    private fun approval(id: String, session: String = "s1", status: String = "pending") = ReiApproval(
        id = id, number = 1, sessionId = session, sessionTitle = "Chat", tool = "send", connector = "mail", operation = "send",
        actionClass = "external", destination = null, summary = "Send mail", argsPreview = "", lengths = listOf("once"),
        status = status, taint = emptyList(), expiresAt = 0, grantLength = null, grantExpiresAt = null, resumesTool = false, execution = null,
    )

    private fun job(id: String, status: String, finished: Long? = null, created: Long = now - 1000, diagnostic: String? = null, session: String? = "s1") =
        BackgroundJob(id, "memory.review", session, status, created, finished, diagnostic, "Planning", "Rei", "model")

    private fun run(id: String, status: String, finished: Long? = null, report: String? = null, session: String? = "s2") =
        TriggerRun(id, status, now - 5000, if (status == "queued") null else now - 4000, finished, null, session, report)

    private fun trigger(id: String, run: TriggerRun?, status: String = "active") = TriggerSummary(id, "Morning check $id", status, run)

    private fun feed(
        approvals: List<ReiApproval> = emptyList(),
        takeovers: Set<String> = emptySet(),
        jobs: List<BackgroundJob> = emptyList(),
        triggers: List<TriggerSummary> = emptyList(),
        changes: Map<String, List<MemoryChange>> = emptyMap(),
    ) = buildActivity(approvals, takeovers, mapOf("s1" to "Planning"), jobs, triggers, changes, now)

    @Test fun needsYouHoldsApprovalsTakeoversAndFailures() {
        val result = feed(
            approvals = listOf(approval("a1"), approval("a2", status = "approved")),
            takeovers = setOf("s1"),
            jobs = listOf(job("j1", "failed", finished = now - 100, diagnostic = "Model unavailable")),
            triggers = listOf(trigger("t1", run("r1", "failed", finished = now - 50))),
        )
        assertEquals(listOf("approval:a1", "takeover:s1", "run:r1", "job:j1"), result.needs.map { it.key })
        assertEquals(4, result.needsCount)
        val job = result.needs.last() as FailureRow
        assertEquals(UiText.Literal("Model unavailable"), job.detail)
        assertEquals(RetryTarget.Job("j1"), job.retry)
        assertEquals(RetryTarget.Trigger("t1"), (result.needs[2] as FailureRow).retry)
    }

    @Test fun oldFailuresStopAskingAndPausedTriggersOfferNoRetry() {
        val result = feed(
            jobs = listOf(job("old", "failed", finished = now - FailureWindowMs - 1)),
            triggers = listOf(trigger("t1", run("r1", "failed", finished = now - 5), status = "paused")),
        )
        assertEquals(listOf("run:r1"), result.needs.map { it.key })
        assertNull((result.needs.single() as FailureRow).retry)
    }

    @Test fun waitingRunsAskOnlyWhenNoApprovalCardCoversThem() {
        val waiting = trigger("t1", run("r1", "waiting", session = "s2"))
        assertTrue(feed(triggers = listOf(waiting)).needs.single() is WaitingRow)
        assertTrue(feed(approvals = listOf(approval("a1", session = "s2")), triggers = listOf(waiting)).needs.none { it is WaitingRow })
    }

    @Test fun runningHoldsQueuedAndRunningWork() {
        val result = feed(
            jobs = listOf(job("j1", "running"), job("j2", "queued"), job("j3", "succeeded", finished = now)),
            triggers = listOf(trigger("t1", run("r1", "running")), trigger("t2", run("r2", "queued"))),
        )
        assertEquals(listOf("job:j1", "job:j2", "run:r1", "run:r2"), result.running.map { it.key })
        assertTrue((result.running[0] as RunningRow).startedAt != null)
        assertNull((result.running[1] as RunningRow).startedAt)
    }

    @Test fun doneHoldsReportsAndReviewsNewestFirstWithTheirChanges() {
        val change = MemoryChange("c1", "add", null, "Likes tea", undoable = true, undone = false)
        val result = feed(
            jobs = listOf(job("j1", "succeeded", finished = now - 100), job("j2", "no_changes", finished = now - 300)),
            triggers = listOf(
                trigger("t1", run("r1", "succeeded", finished = now - 200, report = "All clear")),
                trigger("t2", run("r2", "succeeded", finished = now - 10, report = " ")),
            ),
            changes = mapOf("j1" to listOf(change)),
        )
        assertEquals(listOf("review:j1", "run:r1", "review:j2"), result.done.map { it.key })
        assertEquals(listOf(change), (result.done.first() as MemoryReviewRow).changes)
    }

    @Test fun elapsedUsesMinutesAndHours() {
        assertEquals("0:00", elapsedText(1000, 500))
        assertEquals("2:05", elapsedText(0, 125_000))
        assertEquals("1:02:05", elapsedText(0, 3_725_000))
    }

    @Test fun parsesJobsTriggersAndChanges() {
        val jobs = parseJobs(Json.parseToJsonElement("""{"jobs":[{"id":"j","kind":"memory.review","session_id":null,"status":"failed","created_at":5,"finished_at":null,"diagnostic":"x","summary":{"sessionTitle":"T","agentName":null,"model":"m"}}],"next":null}""").jsonObject)
        assertEquals(BackgroundJob("j", "memory.review", null, "failed", 5, null, "x", "T", null, "m"), jobs.single())
        val triggers = parseTriggers(Json.parseToJsonElement("""{"triggers":[{"id":"t","name":"N","status":"active","lastRun":{"id":"r","status":"running","scheduledAt":1,"startedAt":2,"finishedAt":null,"reason":null,"sessionId":"s","report":null}}]}""").jsonObject)
        assertEquals("running", triggers.single().lastRun?.status)
        assertEquals(2L, triggers.single().lastRun?.startedAt)
        val changes = parseMemoryChanges(Json.parseToJsonElement("""{"c":[{"id":"c","op":"remove","before":"b","after":null,"undoable":true,"undoneAt":null}]}""").jsonObject["c"]!!.let { (it as kotlinx.serialization.json.JsonArray).map { e -> e.jsonObject } })
        assertEquals(MemoryChange("c", "remove", "b", null, undoable = true, undone = false), changes.single())
        assertEquals(UiText.Resource(R.string.activity_change_remove, "b"), changeText(changes.single()))
    }
}
