package dev.rei.android.ui.components.chat

import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.R
import dev.rei.android.data.RunTrace
import dev.rei.android.data.TraceStep
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ToolActivityRowTest {
    @get:Rule
    val compose = createComposeRule()

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun trace() = RunTrace(
        runId = "r1",
        status = "completed",
        triggerMessageId = "m1",
        steps = listOf(
            TraceStep(
                id = "st1",
                type = "tool.call",
                status = "ok",
                startedAt = 0L,
                latencyMs = 420L,
                sideEffect = false,
                toolName = "web_fetch",
                decision = "allow",
                approvalId = null,
                summary = "Fetch guide",
                activity = "Read the Kyoto guide",
                pageId = "pg1",
                pageTitle = "Trip plan",
                webTitle = "Kyoto guide",
                webHost = "guide.example",
                model = null,
                tokens = null,
                errorCode = null,
            ),
        ),
        durationMs = 4000L,
        approvalWaitMs = 0L,
    )

    @Test
    fun simpleModeHidesPageAndWebBadgesAndReportsToggle() {
        val toggles = mutableListOf<Boolean>()
        compose.setContent {
            ReiTheme {
                ToolActivityRow(run = trace(), detail = false, onToggle = { toggles += it })
            }
        }
        val heading = context.getString(R.string.chat_activity_worked_for, context.getString(R.string.chat_duration_s_decimal, 4.0))
        compose.onNodeWithText(heading).performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Read the Kyoto guide").assertExists()
        compose.onNodeWithText("Trip plan").assertDoesNotExist()
        compose.onNodeWithText("Kyoto guide · guide.example").assertDoesNotExist()
        assertEquals(listOf(true), toggles)

        compose.onNodeWithText(heading).performClick()
        compose.waitForIdle()
        assertEquals(listOf(true, false), toggles)
    }

    @Test
    fun detailModeShowsPageAndWebBadges() {
        compose.setContent {
            ReiTheme {
                ToolActivityRow(run = trace(), detail = true)
            }
        }
        val heading = context.getString(R.string.chat_activity_worked_for, context.getString(R.string.chat_duration_s_decimal, 4.0))
        compose.onNodeWithText(heading).performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Trip plan").assertExists()
        compose.onNodeWithText("Kyoto guide · guide.example").assertExists()
    }
}
