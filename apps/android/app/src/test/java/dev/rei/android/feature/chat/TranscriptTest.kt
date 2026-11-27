package dev.rei.android.feature.chat

import dev.rei.android.data.Message
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.ReplyError
import dev.rei.android.data.RunFailure
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptTest {
    private fun user(id: String, text: String = "hi") = Message(id, "user", text, "complete")
    private fun reply(id: String, run: String? = null, text: String = "answer", status: String = "complete") =
        Message(id, "assistant", text, status, runId = run)

    private fun approval(id: String, run: String?) = Message(
        id, "system", "", "complete", runId = run,
        approval = ReiApproval(
            "ap-$id", 1, "s", "Chat", "tool", "connector", "op", "write", null, "Do it", "{}",
            listOf("once"), "pending", emptyList(), 0, null, null, false, null,
        ),
    )

    private fun run(id: String, trigger: String?, status: String = "completed") = RunTrace(
        id, status, trigger,
        listOf(TraceStep("st-$id", "tool.call", "ok", 0, 10, false, "t", null, null, null, null, null, null, null, null, null, null, null)),
        100, 0,
    )

    private fun keys(items: List<TranscriptItem>) = items.map { it.key }

    @Test
    fun activityFollowsItsTriggerAndPrecedesTheReply() {
        val items = buildTranscript(listOf(user("u1"), reply("a1", "r1")), listOf(run("r1", "u1")), null, false)
        assertEquals(listOf("u1", "run:r1", "a1"), keys(items))
    }

    @Test
    fun anApprovalIsLiftedToJustBeforeItsRunsReply() {
        val messages = listOf(user("u1"), approval("p1", "r1"), reply("a1", "r1"))
        val items = buildTranscript(messages, emptyList(), null, false)
        assertEquals(listOf("u1", "p1", "a1"), keys(items))

        // Decided after later chatter, it still sits right above its reply.
        val later = listOf(user("u1"), approval("p1", "r1"), Message("n", "compaction", "", "complete"), reply("a1", "r1"))
        assertEquals(listOf("u1", "notice:n", "p1", "a1"), keys(buildTranscript(later, emptyList(), null, false)))
    }

    @Test
    fun theLastReplyIsMarkedForRetryAndKnowsItsMessage() {
        val items = buildTranscript(listOf(user("u1"), reply("a1"), user("u2"), reply("a2")), emptyList(), null, false)
        val replies = items.filterIsInstance<TranscriptItem.Reply>()
        assertEquals(listOf(false, true), replies.map { it.isLast })
        assertEquals("u2", replies.last().retryOf?.id)
    }

    @Test
    fun theReplyBeingWrittenIsDrawnOnce() {
        val messages = listOf(user("u1"), reply("a1", "r1", text = "partial", status = "streaming"))
        val items = buildTranscript(messages, listOf(run("r1", "u1", "running")), null, true)
        assertEquals(listOf("u1", "run:r1", "a1"), keys(items))
    }

    @Test
    fun thinkingShowsUntilTheReplyHasSomethingToSay() {
        val empty = buildTranscript(listOf(user("u1"), reply("a1", "r1", text = "", status = "streaming")), emptyList(), null, true)
        assertEquals(listOf("u1", "thinking"), keys(empty))
        val thinking = buildTranscript(listOf(user("u1")), emptyList(), null, true)
        assertTrue(thinking.last() is TranscriptItem.Thinking)
        val idle = buildTranscript(listOf(user("u1"), reply("a1")), emptyList(), null, false)
        assertTrue(idle.last() is TranscriptItem.Reply)
    }

    @Test
    fun thinkingNeverShowsWhileAnApprovalWaits() {
        // The approval is last: nothing is thinking, the run waits for the owner.
        val atEnd = buildTranscript(listOf(user("u1"), approval("p1", "r1")), emptyList(), null, true)
        assertTrue(atEnd.none { it is TranscriptItem.Thinking })
        // An older approval is still pending when another message is sent after it.
        val older = buildTranscript(listOf(user("u1"), approval("p1", "r1"), user("u2")), emptyList(), null, true)
        assertTrue(older.none { it is TranscriptItem.Thinking })
        // Once it is decided, the run is thinking again.
        val decided = Message("p1", "system", "", "complete", runId = "r1", approval = approval("p1", "r1").approval!!.copy(status = "approved"))
        val after = buildTranscript(listOf(user("u1"), decided), emptyList(), null, true)
        assertTrue(after.last() is TranscriptItem.Thinking)
    }

    @Test
    fun anUnsentMessageShowsAfterTheTranscriptWithoutThinking() {
        val send = PendingSend("req", "later")
        val items = buildTranscript(listOf(user("u1"), reply("a1")), emptyList(), send, true)
        assertEquals("pending:req", items.last().key)
        assertEquals(1, items.count { it is TranscriptItem.Pending })
        assertTrue(items.none { it is TranscriptItem.Thinking })
    }

    @Test
    fun aLiveRunWhoseMessageIsOffScreenStillShowsItsActivity() {
        val items = buildTranscript(listOf(reply("a0")), listOf(run("r9", "gone", "running")), null, true)
        assertTrue(items.any { it.key == "run:r9" })
    }

    @Test
    fun blankRepliesAndFailuresAreShownOnlyWhenThereIsSomethingToSay() {
        val items = buildTranscript(
            listOf(user("u1"), reply("empty", text = ""), reply("bad", text = "", status = "error"), reply("cut", text = "", status = "aborted")),
            emptyList(), null, false,
        )
        assertEquals(listOf("u1", "bad", "cut"), keys(items))
    }

    @Test
    fun aFailureItsReplyExplainsEndsWithContinueAlone() {
        val error = ReplyError("faulted", "The run hit an internal error and stopped.")
        val failed = reply("a1", "r1", text = "", status = "error").copy(error = error)
        val items = buildTranscript(listOf(user("u1"), failed), emptyList(), null, false, RunFailure("r1", error))
        assertEquals(listOf("u1", "a1", "continue"), keys(items))
        assertEquals(TranscriptItem.Continue(null), items.last())
    }

    @Test
    fun aFailureNothingAboveExplainsSaysWhyBesideContinue() {
        val error = ReplyError("interrupted", "The server stopped while the model was answering.")
        // No reply on screen, a reply of another run, and a reply that words it differently.
        val older = reply("a0", "r0", status = "error").copy(error = error)
        val other = reply("a1", "r1", status = "error").copy(error = ReplyError("internal", "Something else."))
        listOf(emptyList(), listOf(older), listOf(other)).forEach { replies ->
            val items = buildTranscript(listOf(user("u1")) + replies, emptyList(), null, false, RunFailure("r1", error))
            assertEquals(TranscriptItem.Continue(error), items.last())
        }
    }

    @Test
    fun continueIsOfferedOnceAndOnlyForAFailureToResume() {
        val failed = listOf(user("u1"), reply("a1", "r1", status = "error"), user("u2"), reply("a2", "r2", status = "error"))
        assertTrue(buildTranscript(failed, emptyList(), null, false).none { it is TranscriptItem.Continue })
        val items = buildTranscript(failed, emptyList(), PendingSend("req", "again"), false, RunFailure("r2", ReplyError(null, "No.")))
        assertEquals(1, items.count { it is TranscriptItem.Continue })
        assertEquals(listOf("pending:req", "continue"), keys(items).takeLast(2))
    }

    @Test
    fun keysStayStableWhenAReplyArrives() {
        val before = buildTranscript(listOf(user("u1"), reply("a1", text = "part", status = "streaming")), emptyList(), null, true)
        val after = buildTranscript(listOf(user("u1"), reply("a1")), emptyList(), null, false)
        assertEquals(listOf("u1", "a1"), keys(before))
        assertEquals(keys(before), keys(after))
    }
}
