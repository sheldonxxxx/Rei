package dev.rei.android.feature.chat

import dev.rei.android.data.ChatProfile
import dev.rei.android.data.Session
import dev.rei.android.data.SessionDetail
import dev.rei.android.ui.UiText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatPermissionsTest {
    private fun session(profile: ChatProfile = ChatProfile.Standard) =
        Session("s", "a", "Chat", "", "user", "idle", 0, profile = profile)

    private fun chat(profile: ChatProfile = ChatProfile.Standard) = ChatUiState(
        sessionId = "s",
        session = session(profile),
        detail = SessionDetail(session(profile), emptyList(), null, false),
    )

    @Test fun missingRelaxedAndUnknownNamesReadAsStandard() {
        assertEquals(ChatProfile.Standard, ChatProfile.fromWire(null))
        assertEquals(ChatProfile.Standard, ChatProfile.fromWire("relaxed"))
        assertEquals(ChatProfile.Standard, ChatProfile.fromWire("something-new"))
        assertEquals(ChatProfile.Strict, ChatProfile.fromWire("strict"))
        assertEquals(ChatProfile.Yolo, ChatProfile.fromWire("yolo"))
    }

    @Test fun aChatWithNothingLoadedIsStandard() {
        assertEquals(ChatProfile.Standard, ChatUiState().profile)
    }

    @Test fun theLiveViewWinsOverTheCatalogCopy() {
        val state = chat().copy(detail = SessionDetail(session(ChatProfile.Yolo), emptyList(), null, false))
        assertEquals(ChatProfile.Yolo, state.profile)
    }

    @Test fun theChosenLevelShowsAtOnceAndASlowStreamUpdateCannotUndoIt() {
        val saving = chat().startProfileChange(ChatProfile.Yolo)
        assertEquals(ChatProfile.Yolo, saving.profile)
        assertTrue(saving.savingProfile)
        // A stream update with the old level lands before the save is answered.
        val stale = saving.copy(detail = SessionDetail(session(ChatProfile.Standard), emptyList(), null, false))
        assertEquals(ChatProfile.Yolo, stale.profile)
    }

    @Test fun aSavedChoiceBecomesThePartOfTheSession() {
        val saved = chat().startProfileChange(ChatProfile.Yolo).finishProfileChange(ChatProfile.Yolo)
        assertEquals(ChatProfile.Yolo, saved.profile)
        assertEquals(ChatProfile.Yolo, saved.detail?.session?.profile)
        assertEquals(ChatProfile.Yolo, saved.session?.profile)
        assertNull(saved.profileChoice)
        assertFalse(saved.savingProfile)
    }

    @Test fun aFailedSaveRollsBackWithAReason() {
        val failed = chat(ChatProfile.Strict).startProfileChange(ChatProfile.Yolo)
            .failProfileChange("Couldn’t reach Rei. Check your connection and try again.")
        assertEquals(ChatProfile.Strict, failed.profile)
        assertFalse(failed.savingProfile)
        assertEquals(UiText.Literal("Couldn’t reach Rei. Check your connection and try again."), failed.profileError)
    }

    @Test fun tryingAgainClearsTheOldReason() {
        val retry = chat().failProfileChange("No").startProfileChange(ChatProfile.Strict)
        assertNull(retry.profileError)
    }
}
