package dev.rei.android.shell

import dev.rei.android.R
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.Session
import dev.rei.android.ui.UiText
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatGroupingTest {
    private val zone = ZoneId.of("UTC")
    private val now = ZonedDateTime.of(2026, 11, 20, 15, 0, 0, 0, zone).toInstant().toEpochMilli()
    private val agents = listOf(ChatAgent("a1", "Rei", "home-a1"), ChatAgent("a2", "Scout", "home-a2"))

    private fun at(daysAgo: Long) = ZonedDateTime.of(2026, 11, 20, 9, 0, 0, 0, zone).minusDays(daysAgo).toInstant().toEpochMilli()

    private fun chat(
        id: String,
        daysAgo: Long = 0,
        agent: String = "a1",
        origin: String = "user",
        pinned: Boolean = false,
        status: String = "idle",
        approvals: Int = 0,
    ) = Session(id, agent, "Chat $id", "", origin, status, 0, pinned, null, at(daysAgo), approvals)

    private fun group(sessions: List<Session>, agent: String? = "a1", open: String? = null, triggers: Boolean = false) =
        groupChats(sessions, agents, agent, open, triggers, now, zone, Locale.US)

    @Test
    fun groupsByDayLikeTheWebSidebar() {
        val groups = group(
            listOf(chat("a"), chat("b", 1), chat("c", 3), chat("d", 12), chat("e", 40), chat("f", 400)),
        )
        assertEquals(
            listOf(
                UiText.Resource(R.string.drawer_group_today),
                UiText.Resource(R.string.drawer_group_yesterday),
                UiText.Resource(R.string.drawer_group_last_7_days),
                UiText.Resource(R.string.drawer_group_last_30_days),
                UiText.Literal("October"),
                UiText.Resource(R.string.drawer_group_month_year, "October", 2025),
            ),
            groups.map { it.label },
        )
    }

    @Test
    fun pinnedChatsComeFirstAndStayOutOfTheDateGroups() {
        val groups = group(listOf(chat("a"), chat("b", 5, pinned = true)))
        assertEquals(listOf(UiText.Resource(R.string.drawer_group_pinned), UiText.Resource(R.string.drawer_group_today)), groups.map { it.label })
        assertEquals(listOf("b"), groups.first().sessions.map { it.id })
    }

    @Test
    fun listsOneAgentsChatsNewestFirstWithoutHomeChats() {
        val groups = group(
            listOf(chat("old", 0).copy(updatedAt = at(0) - 1000), chat("new"), chat("other", agent = "a2"), chat("home-a1"), chat("h", origin = "home")),
        )
        assertEquals(listOf("new", "old"), groups.single().sessions.map { it.id })
        assertEquals(listOf("other"), group(listOf(chat("other", agent = "a2")), agent = "a2").single().sessions.map { it.id })
    }

    @Test
    fun triggerRunsStayHiddenUnlessTheyNeedYouFailedOrAreOpen() {
        val all = listOf(
            chat("quiet", origin = "trigger"),
            chat("waiting", origin = "trigger", approvals = 1),
            chat("failed", origin = "trigger", status = "failed"),
            chat("open", origin = "trigger"),
        )
        assertEquals(setOf("waiting", "failed", "open"), group(all, open = "open").flatMap { it.sessions }.map { it.id }.toSet())
        assertEquals(4, group(all, triggers = true).flatMap { it.sessions }.size)
    }

    @Test
    fun noAgentSelectedListsEveryAgent() {
        assertEquals(2, group(listOf(chat("a"), chat("b", agent = "a2")), agent = null).flatMap { it.sessions }.size)
    }
}
