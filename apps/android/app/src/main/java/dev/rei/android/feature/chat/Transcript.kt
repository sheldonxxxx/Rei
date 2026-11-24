package dev.rei.android.feature.chat

import dev.rei.android.data.Message
import dev.rei.android.data.RunTrace

/** One thing in the transcript, in reading order. [key] is stable across updates so the list never jumps. */
sealed interface TranscriptItem {
    val key: String

    data class User(val message: Message) : TranscriptItem {
        override val key get() = message.id
    }

    /** A finished (or failed) assistant reply. [retryOf] is your message it answers, for Retry on the last reply. */
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

    data class Notice(val id: String, val text: String) : TranscriptItem {
        override val key get() = "notice:$id"
    }

    data class Pending(val send: PendingSend) : TranscriptItem {
        override val key get() = "pending:${send.requestId}"
    }

    /** The reply that is still being written. */
    data class Streaming(val text: String) : TranscriptItem {
        override val key get() = "streaming"
    }

    /** A run is working and nothing has appeared yet. */
    data object Thinking : TranscriptItem {
        override val key get() = "thinking"
    }
}

/**
 * Turns the chat's messages, the runs' traces and the live reply into the items the transcript draws, oldest first.
 *
 * - A run's activity row sits right after the message that started it, above the reply.
 * - A run's approval card belongs under its activity and above its reply (you decide before reading an answer that depended
 *   on it), so it is lifted to just before that run's reply, as on web.
 * - Your unsent message and the streaming reply come last.
 */
fun buildTranscript(
    messages: List<Message>,
    runs: List<RunTrace>,
    generation: String?,
    pending: PendingSend?,
    busy: Boolean,
): List<TranscriptItem> {
    val ordered = liftApprovals(messages)
    val runsByTrigger = runs.filter { it.triggerMessageId != null && it.steps.isNotEmpty() }.groupBy { it.triggerMessageId }
    val shownIds = ordered.map(Message::id).toSet()
    val items = mutableListOf<TranscriptItem>()
    val lastReply = ordered.lastOrNull { it.role == "assistant" && (it.text.isNotBlank() || it.parts.isNotEmpty() || it.status == "failed") }?.id
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
            message.role == "assistant" -> {
                val visible = message.text.isNotBlank() || message.parts.isNotEmpty() || message.status == "failed" || message.status == "cancelled"
                if (visible) items += TranscriptItem.Reply(message, isLast = message.id == lastReply, retryOf = lastUser)
            }
            message.role == "compaction" -> items += TranscriptItem.Notice(message.id, message.text.ifBlank { "Earlier context was summarized." })
            message.role == "reset" -> items += TranscriptItem.Notice(message.id, message.text.ifBlank { "New context" })
        }
    }
    // A live run whose message is not on screen (the trigger scrolled out of the window) still shows its activity.
    val live = runs.filter { it.live && it.steps.isNotEmpty() && it.triggerMessageId !in shownIds }
    live.forEach { items += TranscriptItem.Activity(it) }
    if (pending != null) items += TranscriptItem.Pending(pending)
    // Any approval still waiting, wherever it sits (an older one stays pending when you send another message).
    val awaitingApproval = ordered.any { it.approval?.status == "pending" }
    when {
        !generation.isNullOrBlank() -> items += TranscriptItem.Streaming(generation)
        // Not while an approval waits: nothing is "thinking" then, the run is waiting for you.
        busy && pending == null && !awaitingApproval && items.lastOrNull().let {
            it is TranscriptItem.User || it == null || it is TranscriptItem.Approval
        } -> items += TranscriptItem.Thinking
    }
    return items
}

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
