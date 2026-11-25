package dev.rei.android.ui.components

import android.content.Context
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.R
import dev.rei.android.data.ReiApproval
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class ApprovalCardTest {
    @get:Rule
    val compose = createComposeRule()

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun str(id: Int, vararg args: Any) = context.getString(id, *args)

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
        compose.onNodeWithText(str(R.string.approval_needed)).assertExists()
        compose.onNodeWithText(str(R.string.approval_wants_to, "Rei", "send the summary to Ana")).assertExists()
        compose.onNodeWithText(str(R.string.approval_allow_once)).assertIsEnabled()
        compose.onNodeWithText(str(R.string.approval_more_options)).assertExists()
        compose.onNodeWithText(str(R.string.approval_deny)).assertExists()
    }

    @Test
    fun allowOnceAnswersOnce() {
        show(approval())
        compose.onNodeWithText(str(R.string.approval_allow_once)).performClick()
        compose.waitForIdle()
        assertEquals(Triple(true, "once", null), decision)
    }

    @Test
    fun denyAnswersNo() {
        show(approval())
        compose.onNodeWithText(str(R.string.approval_deny)).performClick()
        compose.waitForIdle()
        assertEquals(false, decision?.first)
    }

    @Test
    fun withOnlyOneLengthThereAreNoMoreOptions() {
        show(approval(lengths = listOf("once")))
        compose.onNodeWithText(str(R.string.approval_more_options)).assertDoesNotExist()
    }

    @Test
    fun aDecidedApprovalIsAQuietRecordWithNoButtons() {
        show(approval(status = "approved"))
        compose.onNodeWithText(str(R.string.approval_allow_once)).assertDoesNotExist()
        compose.onNodeWithText(str(R.string.approval_deny)).assertDoesNotExist()
        compose.onNodeWithText("send the summary to Ana").assertExists()
    }
}
