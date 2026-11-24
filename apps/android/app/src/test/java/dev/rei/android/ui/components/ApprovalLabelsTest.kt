package dev.rei.android.ui.components

import dev.rei.android.R
import dev.rei.android.ui.UiText
import org.junit.Assert.assertEquals
import org.junit.Test

class ApprovalLabelsTest {
    @Test
    fun decidedCardsUseTheWebWording() {
        assertEquals(UiText.Resource(R.string.approval_grant_once), decidedGrantLabel("once"))
        assertEquals(UiText.Resource(R.string.approval_grant_session), decidedGrantLabel("session"))
        assertEquals(UiText.Resource(R.string.approval_grant_web_session), decidedGrantLabel("web_session"))
        assertEquals(UiText.Resource(R.string.approval_grant_agent), decidedGrantLabel("agent"))
        assertEquals(UiText.Resource(R.string.approval_grant_always), decidedGrantLabel("always"))
        assertEquals(UiText.Resource(R.string.approval_grant_fallback), decidedGrantLabel("unknown"))
    }
}
