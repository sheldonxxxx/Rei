package dev.rei.android.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.rei.android.data.ChatProfile
import dev.rei.android.ui.components.chat.Composer
import dev.rei.android.ui.components.chat.ComposerState
import dev.rei.android.ui.components.chat.PermissionsSheet
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** The permission chip under the composer and the sheet it opens, found by what TalkBack reads. */
class PermissionsPickerTest {
    @get:Rule
    val compose = createComposeRule()

    private val chosen = mutableListOf<ChatProfile>()
    private var settingsOpened = 0

    /** A level's row in the sheet (not the chip, which can carry the same word). */
    private fun level(label: String) = compose.onNode(isSelectable() and hasText(label))

    /** The chip and sheet wired the way the chat screen wires them. */
    private fun show(initial: ChatProfile, saving: Boolean = false, error: String? = null) {
        compose.setContent {
            ReiTheme {
                var open by androidx.compose.runtime.remember { mutableStateOf(false) }
                var current by androidx.compose.runtime.remember { mutableStateOf(initial) }
                Composer(
                    state = ComposerState(agentName = "Rei", profile = current),
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    onAttach = {},
                    onRemoveAttachment = {},
                    onModel = {},
                    onEffort = {},
                    onPermissions = { open = true },
                )
                if (open) {
                    PermissionsSheet(
                        current = current,
                        saving = saving,
                        error = error,
                        onDismiss = { open = false },
                        onSelect = { chosen += it; current = it; open = false },
                        onOpenSettings = { settingsOpened++ },
                    )
                }
            }
        }
    }

    @Test
    fun theChipNamesTheLevelAndPicksYoloFromTheSheet() {
        show(ChatProfile.Standard)
        compose.onNodeWithContentDescription("Permissions: Standard. Change").performClick()
        compose.onNodeWithText("Permissions").assertExists()
        level("Standard").assertIsSelected()
        level("Strict").assertExists()
        level("YOLO").assertTextContains(ChatProfile.Yolo.description, substring = true)
        level("YOLO").performClick()
        assertEquals(listOf(ChatProfile.Yolo), chosen)
        // The sheet closed, and the chip now reads YOLO.
        compose.onNodeWithText("This chat only.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Permissions: YOLO. Change").assertExists()
    }

    @Test
    fun theCurrentLevelIsSelectedWhenTheSheetOpens() {
        show(ChatProfile.Strict)
        compose.onNodeWithContentDescription("Permissions: Strict. Change").performClick()
        level("Strict").assertIsSelected()
    }

    @Test
    fun anErrorShowsInTheSheetAndKeepsItOpen() {
        show(ChatProfile.Standard, error = "Couldn’t reach Rei. Check your connection and try again.")
        compose.onNodeWithContentDescription("Permissions: Standard. Change").performClick()
        compose.onNodeWithText("Couldn’t reach Rei. Check your connection and try again.").assertExists()
        compose.onNodeWithText("This chat only.").assertExists()
    }

    @Test
    fun levelsWaitWhileASaveIsInFlight() {
        show(ChatProfile.Standard, saving = true)
        compose.onNodeWithContentDescription("Permissions: Standard. Change").performClick()
        level("YOLO").assertIsNotEnabled()
    }

    @Test
    fun theAgentDefaultOpensItsSettingsInWeb() {
        show(ChatProfile.Standard)
        compose.onNodeWithContentDescription("Permissions: Standard. Change").performClick()
        compose.onNodeWithContentDescription("Opens in web").assertExists()
        compose.onNodeWithText("Settings → Permissions").assertIsEnabled().performClick()
        assertEquals(1, settingsOpened)
    }

    @Test
    fun noChipWithoutALevel() {
        compose.setContent {
            ReiTheme {
                Composer(
                    state = ComposerState(agentName = "Rei"),
                    onDraftChange = {}, onSend = {}, onStop = {}, onAttach = {}, onRemoveAttachment = {}, onModel = {}, onEffort = {},
                )
            }
        }
        compose.onNodeWithContentDescription("Permissions: Standard. Change").assertDoesNotExist()
    }
}
