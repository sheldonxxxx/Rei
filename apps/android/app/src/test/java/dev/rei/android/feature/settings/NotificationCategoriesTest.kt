package dev.rei.android.feature.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationCategoriesTest {
    private fun parse(text: String) = Json.parseToJsonElement(text).jsonObject.notificationCategories()

    @Test
    fun readsWhichCategoriesTheDeviceReceives() {
        val states = parse("""{"categories":{"approvals":true,"replies":false,"backups":true}}""")
        assertEquals(true, states["approvals"])
        assertEquals(false, states["replies"])
        assertEquals(true, states["backups"])
    }

    @Test
    fun anAnswerWithoutCategoriesIsEmptySoEveryRowStaysOn() {
        assertTrue(parse("""{}""").isEmpty())
    }

    @Test
    fun theScreenListsTheServersCategoriesInOrder() {
        assertEquals(
            listOf("approvals", "takeovers", "replies", "trigger_results", "trigger_problems", "backups"),
            NotifyCategories.map { it.key },
        )
    }
}
