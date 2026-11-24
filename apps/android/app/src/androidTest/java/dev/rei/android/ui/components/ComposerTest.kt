package dev.rei.android.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.rei.android.data.AttachmentRef
import dev.rei.android.ui.components.chat.Composer
import dev.rei.android.ui.components.chat.ComposerState
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The composer, found the way TalkBack finds it: by content description. */
class ComposerTest {
    @get:Rule
    val compose = createComposeRule()

    private var sent = 0
    private var stopped = 0
    private var attached = 0
    private var model = 0
    private var removed: AttachmentRef? = null

    private fun show(initial: ComposerState = ComposerState(agentName = "Rei"), hostState: (ComposerState) -> ComposerState = { it }) {
        compose.setContent {
            ReiTheme {
                var state by androidx.compose.runtime.remember { mutableStateOf(initial) }
                Composer(
                    state = hostState(state),
                    onDraftChange = { state = state.copy(draft = it) },
                    onSend = { sent++ },
                    onStop = { stopped++ },
                    onAttach = { attached++ },
                    onRemoveAttachment = { removed = it },
                    onModel = { model++ },
                    onEffort = {},
                )
            }
        }
    }

    @Test
    fun sendWaitsForSomethingToSend() {
        show()
        compose.onNodeWithContentDescription("Send message").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Message").performTextInput("Hello")
        compose.onNodeWithContentDescription("Send message").assertIsEnabled().performClick()
        assertEquals(1, sent)
    }

    @Test
    fun aRunningReplyOffersStopInPlaceOfSend() {
        show(ComposerState(agentName = "Rei", running = true))
        compose.onNodeWithContentDescription("Stop reply").assertIsEnabled().performClick()
        assertEquals(1, stopped)
        assertEquals(0, sent)
    }

    @Test
    fun anApprovalWaitingSaysSoAndHoldsSend() {
        show(ComposerState(agentName = "Rei", waitingForAnswer = true))
        compose.onNodeWithText("Waiting for your answer").assertExists()
        compose.onNodeWithContentDescription("Send message").assertIsNotEnabled()
    }

    @Test
    fun aDraftKeptWhileWaitingStillCannotBeSent() {
        show(ComposerState(agentName = "Rei", draft = "later", waitingForAnswer = true))
        compose.onNodeWithContentDescription("Send message").assertIsNotEnabled()
    }

    @Test
    fun theAttachButtonAndModelChipAreReachable() {
        show(ComposerState(agentName = "Rei", modelLabel = "GPT 5", effortLabel = "Medium"))
        compose.onNodeWithContentDescription("Attach").performClick()
        compose.onNodeWithContentDescription("Model: GPT 5").performClick()
        compose.onNodeWithContentDescription("Reasoning effort: Medium").assertExists()
        assertEquals(1, attached)
        assertEquals(1, model)
    }

    @Test
    fun attachmentsShowAsChipsYouCanRemove() {
        val file = AttachmentRef("f", "v", "notes.txt", 12)
        show(ComposerState(agentName = "Rei", attachments = listOf(file)))
        compose.onNodeWithText("notes.txt").assertExists()
        compose.onNodeWithContentDescription("Remove notes.txt").performClick()
        assertTrue(removed == file)
    }

    @Test
    fun theContextMeterAppearsOnlyWhenTheChatIsGettingFull() {
        show(ComposerState(agentName = "Rei", contextPercent = 40))
        compose.onNodeWithContentDescription("Context used: 40 percent").assertDoesNotExist()
    }

    @Test
    fun theContextMeterShowsWhenFull() {
        show(ComposerState(agentName = "Rei", contextPercent = 82))
        compose.onNodeWithContentDescription("Context used: 82 percent").assertExists()
    }
}
