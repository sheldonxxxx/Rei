package dev.rei.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ReiNotificationsTest {
    private val push = mapOf("sessionId" to "s1", "messageId" to "m1", "event" to "reply", "title" to "Research", "body" to "Done.")

    @Test
    fun contentCarriesTheTitleAndBody() {
        val content = NotificationContent.from(push)
        assertEquals("Research", content.title)
        assertEquals("Done.", content.body)
    }

    @Test
    fun aBlankTitleFallsBackToTheAppNameAndAMissingBodyIsEmpty() {
        val content = NotificationContent.from(mapOf("sessionId" to "s1", "title" to "  "))
        assertEquals("Rei", content.title)
        assertEquals("", content.body)
    }

    @Test
    fun theSamePushReplacesItselfAndDifferentOnesDoNotCollide() {
        assertEquals(NotificationContent.from(push).id, NotificationContent.from(push.toMap()).id)
        assertNotEquals(NotificationContent.from(push).id, NotificationContent.from(push + ("messageId" to "m2")).id)
        assertNotEquals(NotificationContent.from(push).id, NotificationContent.from(push + ("event" to "approval")).id)
        assertNotEquals(NotificationContent.from(push).id, NotificationContent.from(push + ("sessionId" to "s2")).id)
    }
}
