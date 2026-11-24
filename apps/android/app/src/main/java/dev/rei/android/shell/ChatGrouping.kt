package dev.rei.android.shell

import dev.rei.android.data.ChatAgent
import dev.rei.android.data.Session
import java.time.Instant

import java.time.ZoneId
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** A run of chats under one drawer heading ("Pinned", "Today", "Yesterday", "Previous 7 days", a month). */
data class ChatGroup(val label: String, val sessions: List<Session>)

/**
 * The drawer's chat list, the way web's `selectSessions` and `dateGroup` build the sidebar: one agent's chats, newest
 * first; home chats are reached through the agents, not listed; a trigger run stays out unless it is open, needs you,
 * failed, or [showTriggers] is on. Pinned chats come first under "Pinned".
 */
fun groupChats(
    sessions: List<Session>,
    agents: List<ChatAgent>,
    agentId: String?,
    openSessionId: String?,
    showTriggers: Boolean,
    now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<ChatGroup> {
    val homeIds = agents.map { it.homeSessionId }.toSet()
    val shown = sessions
        .filter { s ->
            (agentId == null || s.agentId == agentId) && s.origin != "home" && s.id !in homeIds &&
                (s.id == openSessionId || s.origin != "trigger" || showTriggers || s.status == "failed" ||
                    s.pendingApprovals > 0 || s.status == "waiting_for_user")
        }
        .sortedWith(compareByDescending<Session> { it.updatedAt }.thenByDescending { it.id })
    val groups = mutableListOf<ChatGroup>()
    val pinned = shown.filter { it.pinned }
    if (pinned.isNotEmpty()) groups += ChatGroup("Pinned", pinned)
    for (session in shown.filterNot { it.pinned }) {
        val label = dateGroup(session.updatedAt, now, zone, locale)
        val last = groups.lastOrNull()
        if (last != null && last.label == label && label != "Pinned") groups[groups.lastIndex] = last.copy(sessions = last.sessions + session)
        else groups += ChatGroup(label, listOf(session))
    }
    return groups
}

/** Web's `dateGroup`: Today, Yesterday, Previous 7 days, Previous 30 days, then the month (with the year when it is not this one). */
fun dateGroup(timestamp: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val day = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(day, today)
    return when {
        days <= 0 -> "Today"
        days == 1L -> "Yesterday"
        days < 7 -> "Previous 7 days"
        days < 30 -> "Previous 30 days"
        else -> {
            val month = day.month.getDisplayName(TextStyle.FULL, locale)
            if (day.year == today.year) month else "$month ${day.year}"
        }
    }
}
