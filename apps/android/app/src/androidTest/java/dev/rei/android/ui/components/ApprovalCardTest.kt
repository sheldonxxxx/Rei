package dev.rei.android.ui.components

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.rei.android.data.ReiApproval
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ApprovalCardTest {
    @get:Rule
    val compose = createComposeRule()

    private fun approval(status: String = "pending", lengths: List<String> = listOf("once", "session")) = ReiApproval(
        "ap1", 1, "s1", "Research", "send_email", "mail", "send", "write", "ana@example.com", "send the summary to Ana", "{}",
        lengths, status, emptyList(), 0, null, null, false, null,
    )

    private var decision: Triple<Boolean, String, Int?>? = null

    private fun show(item: ReiApproval) {
        compose.setContent {
            ReiTheme {
                ApprovalCard(item, onDecide = { approve, length, hours ->
                    decision = Triple(approve, length, hours)
                    item.copy(status = if (approve) "approved" else "denied")
                }, agentName = "Rei")
            }
        }
    }

    @Test
    fun aPendingApprovalAsksAndOffersAllowOnceMoreOptionsAndDeny() {
        show(approval())
        compose.onNodeWithText("Approval needed").assertExists()
        compose.onNodeWithText("Rei wants to: send the summary to Ana").assertExists()
        compose.onNodeWithText("Allow once").assertIsEnabled()
        compose.onNodeWithText("More options").assertExists()
        compose.onNodeWithText("Deny").assertExists()
    }

    @Test
    fun allowOnceAnswersOnce() {
        show(approval())
        compose.onNodeWithText("Allow once").performClick()
        compose.waitForIdle()
        assertEquals(Triple(true, "once", null), decision)
    }

    @Test
    fun denyAnswersNo() {
        show(approval())
        compose.onNodeWithText("Deny").performClick()
        compose.waitForIdle()
        assertEquals(false, decision?.first)
    }

    @Test
    fun withOnlyOneLengthThereAreNoMoreOptions() {
        show(approval(lengths = listOf("once")))
        compose.onNodeWithText("More options").assertDoesNotExist()
    }

    @Test
    fun aDecidedApprovalIsAQuietRecordWithNoButtons() {
        show(approval(status = "approved"))
        compose.onNodeWithText("Allow once").assertDoesNotExist()
        compose.onNodeWithText("Deny").assertDoesNotExist()
        compose.onNodeWithText("send the summary to Ana").assertExists()
    }
}
