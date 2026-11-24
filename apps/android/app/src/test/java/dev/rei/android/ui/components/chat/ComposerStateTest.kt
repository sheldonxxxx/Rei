package dev.rei.android.ui.components.chat

import dev.rei.android.data.AttachmentRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerStateTest {
    private val file = AttachmentRef("f", "v", "notes.txt", 10)

    @Test
    fun sendNeedsContent() {
        assertFalse(ComposerState().canSend)
        assertFalse(ComposerState(draft = "   ").canSend)
        assertTrue(ComposerState(draft = "hello").canSend)
        assertTrue(ComposerState(attachments = listOf(file)).canSend)
    }

    @Test
    fun sendWaitsForUploadsSendsAndAnswers() {
        assertFalse(ComposerState(draft = "hi", uploading = true).canSend)
        assertFalse(ComposerState(draft = "hi", sending = true).canSend)
        assertFalse(ComposerState(draft = "hi", waitingForAnswer = true).canSend)
        assertFalse(ComposerState(draft = "hi", enabled = false).canSend)
    }

    @Test
    fun placeholderNamesTheAgentOrTheWait() {
        assertEquals("Message", ComposerState().placeholder)
        assertEquals("Message Rei", ComposerState(agentName = "Rei").placeholder)
        assertEquals("Waiting for your answer", ComposerState(agentName = "Rei", waitingForAnswer = true).placeholder)
    }

    @Test
    fun slashQueryMatchesLeadingTokenOnly() {
        assertEquals(SlashMatch(0, 1, ""), parseSlashQuery("/", 1))
        assertEquals(SlashMatch(2, 7, "comp"), parseSlashQuery("  /comp", 7))
        assertNull(parseSlashQuery("/compact keep plan", 18))
        assertNull(parseSlashQuery("hello /skill", 12))
        assertNull(parseSlashQuery("/skill", 0))
    }
}
