package dev.rei.android.shell

import dev.rei.android.R
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.Session
import dev.rei.android.ui.UiText
import java.time.Instant

import java.time.ZoneId
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.util.Locale

/** A run of chats under one drawer heading ("Pinned", "Today", "Yesterday", "Previous 7 days", a month). */
data class ChatGroup(val key: String, val label: UiText, val sessions: List<Session>)

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
    if (pinned.isNotEmpty()) groups += ChatGroup("pinned", UiText.Resource(R.string.drawer_group_pinned), pinned)
    for (session in shown.filterNot { it.pinned }) {
        val (key, label) = dateGroupKeyed(session.updatedAt, now, zone, locale)
        val last = groups.lastOrNull()
        if (last != null && last.key == key) groups[groups.lastIndex] = last.copy(sessions = last.sessions + session)
        else groups += ChatGroup(key, label, listOf(session))
    }
    return groups
}

/** Web's `dateGroup`: Today, Yesterday, Previous 7 days, Previous 30 days, then the month (with the year when it is not this one). */
fun dateGroup(timestamp: Long, now: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): UiText =
    dateGroupKeyed(timestamp, now, zone, locale).second

private fun dateGroupKeyed(timestamp: Long, now: Long, zone: ZoneId, locale: Locale): Pair<String, UiText> {
    val day = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val days = ChronoUnit.DAYS.between(day, today)
    return when {
        days <= 0 -> "today" to UiText.Resource(R.string.drawer_group_today)
        days == 1L -> "yesterday" to UiText.Resource(R.string.drawer_group_yesterday)
        days < 7 -> "last7" to UiText.Resource(R.string.drawer_group_last_7_days)
        days < 30 -> "last30" to UiText.Resource(R.string.drawer_group_last_30_days)
        else -> {
            val month = day.month.getDisplayName(TextStyle.FULL, locale)
            val label = if (day.year == today.year) UiText.Literal(month)
            else UiText.Resource(R.string.drawer_group_month_year, month, day.year)
            "${day.year}-${day.monthValue}" to label
        }
    }
}
