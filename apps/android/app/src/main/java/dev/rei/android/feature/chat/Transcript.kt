package dev.rei.android.feature.chat

import dev.rei.android.R
import dev.rei.android.data.Message
import dev.rei.android.data.ReplyError
import dev.rei.android.data.RunFailure
import dev.rei.android.data.RunTrace
import dev.rei.android.ui.UiText

/** One thing in the transcript, in reading order. [key] is stable across updates so the list never jumps. */
sealed interface TranscriptItem {
    val key: String

    data class User(val message: Message) : TranscriptItem {
        override val key get() = message.id
    }

    /** An assistant reply: being written, finished, stopped or failed. [retryOf] is your message it answers, for Retry on the last reply. */
    data class Reply(val message: Message, val isLast: Boolean, val retryOf: Message?) : TranscriptItem {
        override val key get() = message.id
    }

    data class Activity(val run: RunTrace) : TranscriptItem {
        override val key get() = "run:${run.runId}"
    }

    data class Approval(val message: Message) : TranscriptItem {
        override val key get() = message.id
    }

    data class Takeover(val message: Message) : TranscriptItem {
        override val key get() = message.id
    }

    data class Notice(val id: String, val text: UiText) : TranscriptItem {
        override val key get() = "notice:$id"
    }

    data class Pending(val send: PendingSend) : TranscriptItem {
        override val key get() = "pending:${send.requestId}"
    }

    /** The last run failed and can be continued. [error] is null when its reply above already says why. */
    data class Continue(val error: ReplyError?) : TranscriptItem {
        override val key get() = "continue"
    }

    /** A run is working and nothing has appeared yet. */
    data object Thinking : TranscriptItem {
        override val key get() = "thinking"
    }
}

/**
 * Turns the chat's messages and the runs' traces into the items the transcript draws, oldest first.
 *
 * - A run's activity row sits right after the message that started it, above the reply.
 * - A run's approval card belongs under its activity and above its reply (you decide before reading an answer that depended
 *   on it), so it is lifted to just before that run's reply, as on web.
 * - The reply being written is the run's own assistant message, with status `streaming`; it is drawn once, in its place.
 * - Your unsent message comes after the messages.
 * - A run that failed and can be continued ends the list with Continue, once.
 */
fun buildTranscript(
    messages: List<Message>,
    runs: List<RunTrace>,
    pending: PendingSend?,
    busy: Boolean,
    failure: RunFailure? = null,
): List<TranscriptItem> {
    val ordered = liftApprovals(messages)
    val runsByTrigger = runs.filter { it.triggerMessageId != null && it.steps.isNotEmpty() }.groupBy { it.triggerMessageId }
    val shownIds = ordered.map(Message::id).toSet()
    val items = mutableListOf<TranscriptItem>()
    val lastReply = ordered.lastOrNull { it.role == "assistant" && it.isWorthShowing() }?.id
    var lastUser: Message? = null
    for (message in ordered) {
        when {
            message.approval != null -> items += TranscriptItem.Approval(message)
            message.takeover != null -> items += TranscriptItem.Takeover(message)
            message.role == "user" -> {
                lastUser = message
                items += TranscriptItem.User(message)
                runsByTrigger[message.id]?.forEach { items += TranscriptItem.Activity(it) }
            }
            message.role == "assistant" -> if (message.isWorthShowing()) {
                items += TranscriptItem.Reply(message, isLast = message.id == lastReply, retryOf = lastUser)
            }
            message.role == "compaction" -> items += TranscriptItem.Notice(
                message.id,
                if (message.text.isNotBlank()) UiText.Literal(message.text) else UiText.Resource(R.string.chat_notice_compacted),
            )
            message.role == "reset" -> items += TranscriptItem.Notice(
                message.id,
                if (message.text.isNotBlank()) UiText.Literal(message.text) else UiText.Resource(R.string.chat_notice_reset),
            )
        }
    }
    // A live run whose message is not on screen (the trigger scrolled out of the window) still shows its activity.
    val live = runs.filter { it.live && it.steps.isNotEmpty() && it.triggerMessageId !in shownIds }
    live.forEach { items += TranscriptItem.Activity(it) }
    if (pending != null) items += TranscriptItem.Pending(pending)
    // Any approval still waiting, wherever it sits (an older one stays pending when you send another message).
    val awaitingApproval = ordered.any { it.approval?.status == "pending" }
    // Not while an approval waits: nothing is "thinking" then, the run is waiting for you.
    if (busy && pending == null && !awaitingApproval && items.lastOrNull().let {
            it is TranscriptItem.User || it == null || it is TranscriptItem.Approval
        }
    ) items += TranscriptItem.Thinking
    if (failure != null) {
        val explained = failure.runId != null && ordered.any {
            it.runId == failure.runId && it.status == "error" && it.error?.message == failure.error.message
        }
        items += TranscriptItem.Continue(failure.error.takeUnless { explained })
    }
    return items
}

/** An empty reply is shown only when how it ended is the news. */
private fun Message.isWorthShowing() = text.isNotBlank() || parts.isNotEmpty() || status == "error" || status == "aborted"

private fun liftApprovals(messages: List<Message>): List<Message> {
    val replyAt = HashMap<String, Int>()
    messages.forEachIndexed { index, message -> if (message.role == "assistant" && message.runId != null) replyAt[message.runId] = index }
    if (replyAt.isEmpty()) return messages
    val byRun = HashMap<String, MutableList<Message>>()
    val lifted = HashSet<String>()
    for (message in messages) {
        val run = message.runId
        if (message.approval == null || run == null || run !in replyAt) continue
        lifted += message.id
        byRun.getOrPut(run) { mutableListOf() } += message
    }
    if (lifted.isEmpty()) return messages
    val out = mutableListOf<Message>()
    messages.forEachIndexed { index, message ->
        val run = message.runId
        if (message.role == "assistant" && run != null && replyAt[run] == index) byRun[run]?.let(out::addAll)
        if (message.id !in lifted) out += message
    }
    return out
}
