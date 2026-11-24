package dev.rei.android.ui.components

import android.content.Context
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
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.R
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

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun str(id: Int, vararg args: Any) = context.getString(id, *args)

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
        val standard = str(ChatProfile.Standard.labelRes)
        val strict = str(ChatProfile.Strict.labelRes)
        val yolo = str(ChatProfile.Yolo.labelRes)
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, standard)).performClick()
        compose.onNodeWithText(str(R.string.composer_permissions_title)).assertExists()
        level(standard).assertIsSelected()
        level(strict).assertExists()
        level(yolo).assertTextContains(str(ChatProfile.Yolo.descriptionRes), substring = true)
        level(yolo).performClick()
        assertEquals(listOf(ChatProfile.Yolo), chosen)
        // The sheet closed, and the chip now reads YOLO.
        compose.onNodeWithText(str(R.string.composer_permissions_this_chat)).assertDoesNotExist()
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, yolo)).assertExists()
    }

    @Test
    fun theCurrentLevelIsSelectedWhenTheSheetOpens() {
        show(ChatProfile.Strict)
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, str(ChatProfile.Strict.labelRes))).performClick()
        level(str(ChatProfile.Strict.labelRes)).assertIsSelected()
    }

    @Test
    fun anErrorShowsInTheSheetAndKeepsItOpen() {
        val networkErr = str(R.string.chat_err_network)
        show(ChatProfile.Standard, error = networkErr)
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, str(ChatProfile.Standard.labelRes))).performClick()
        compose.onNodeWithText(networkErr).assertExists()
        compose.onNodeWithText(str(R.string.composer_permissions_this_chat)).assertExists()
    }

    @Test
    fun levelsWaitWhileASaveIsInFlight() {
        show(ChatProfile.Standard, saving = true)
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, str(ChatProfile.Standard.labelRes))).performClick()
        level(str(ChatProfile.Yolo.labelRes)).assertIsNotEnabled()
    }

    @Test
    fun theAgentDefaultOpensItsSettings() {
        show(ChatProfile.Standard)
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, str(ChatProfile.Standard.labelRes))).performClick()
        // The Permissions settings page is native, so the row must not claim to open the web app.
        compose.onNodeWithContentDescription("Opens in web").assertDoesNotExist()
        compose.onNodeWithText(str(R.string.composer_permissions_settings)).assertIsEnabled().performClick()
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
        compose.onNodeWithContentDescription(str(R.string.composer_permissions_desc, str(ChatProfile.Standard.labelRes))).assertDoesNotExist()
    }
}
