package dev.rei.android.feature

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.BuildConfig
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApproval
import dev.rei.android.feature.activity.ActivityActions
import dev.rei.android.feature.activity.ActivityContent
import dev.rei.android.feature.activity.ActivityFeed
import dev.rei.android.feature.activity.ActivityUiState
import dev.rei.android.feature.activity.ApprovalRow
import dev.rei.android.feature.activity.BackgroundJob
import dev.rei.android.feature.activity.FailureRow
import dev.rei.android.feature.activity.MemoryChange
import dev.rei.android.feature.activity.MemoryReviewRow
import dev.rei.android.feature.activity.RetryTarget
import dev.rei.android.feature.activity.RunningRow
import dev.rei.android.feature.settings.AppearanceScreen
import dev.rei.android.feature.settings.SettingsIndex
import dev.rei.android.feature.settings.updateSummary
import dev.rei.android.shell.Destination
import dev.rei.android.shell.DrawerMode
import dev.rei.android.shell.LocalShell
import dev.rei.android.shell.ShellController
import dev.rei.android.ui.UiText
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.ThemePreference
import dev.rei.android.update.UpdateState
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Background Activity and Settings, found the way TalkBack finds them: by content description and text. */
class ActivitySettingsTest {
    @get:Rule
    val compose = createComposeRule()

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun str(id: Int, vararg args: Any) = context.getString(id, *args)

    private val approval = ReiApproval(
        "ap1", 1, "s1", "Research", "send_email", "mail", "send", "write", "ana@example.com", "send the summary to Ana", "{}",
        listOf("once", "session"), "pending", emptyList(), 0, null, null, false, null,
    )
    private val failedJob = BackgroundJob("j1", "memory.review", "s1", "failed", 1, 2, "Model unavailable", "Planning", "Rei", "m")
    private val reviewed = BackgroundJob("j2", "memory.review", "s1", "succeeded", 1, 2, null, "Planning", "Rei", "m")
    private val change = MemoryChange("c1", "add", null, "Likes tea", undoable = true, undone = false)

    private val feed = ActivityFeed(
        needs = listOf(
            ApprovalRow(approval),
            FailureRow("job:j1", UiText.Literal("Memory review"), UiText.Literal("Model unavailable"), "s1", RetryTarget.Job("j1")),
        ),
        running = listOf(RunningRow("run:r1", UiText.Literal("Morning check"), UiText.Literal("Trigger run"), System.currentTimeMillis() - 65_000, "s2")),
        done = listOf(MemoryReviewRow(reviewed, listOf(change))),
    )

    private var retried: String? = null
    private var undone: String? = null
    private var opened: String? = null

    @Composable
    private fun Shell(content: @Composable () -> Unit) = ReiTheme {
        CompositionLocalProvider(LocalShell provides ShellController(Destination.Activity, DrawerMode.Modal, {}, {}, {}), content = content)
    }

    private fun showActivity(state: ActivityUiState = ActivityUiState(feed = feed, loaded = true)) {
        compose.setContent {
            Shell {
                ActivityContent(
                    state,
                    ActivityActions(
                        onRefresh = {}, onRetry = { retried = it.key }, onUndo = { undone = it.id },
                        onDecide = { a, approve, _, _ -> a.copy(status = if (approve) "approved" else "denied") },
                        onOpenChat = { opened = it }, onDismissError = {},
                    ),
                )
            }
        }
    }

    @Test
    fun theSegmentedFiltersCarryTheirCounts() {
        showActivity()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_cd_count, str(R.string.activity_segment_needs_you), 2)).assertIsSelected()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_cd_count, str(R.string.activity_segment_running), 1)).assertExists()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_cd_count, str(R.string.activity_segment_done), 1)).assertExists()
        compose.onNodeWithText(str(R.string.approval_needed)).assertExists()
    }

    @Test
    fun aFailureOffersRetryAndOpensItsChat() {
        showActivity()
        compose.onNodeWithContentDescription(str(R.string.activity_retry_item, "Memory review")).performClick()
        assertEquals("job:j1", retried)
        compose.onNodeWithText("Model unavailable").performClick()
        assertEquals("s1", opened)
    }

    @Test
    fun runningShowsElapsedTimeInTabularFigures() {
        showActivity()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_cd_count, str(R.string.activity_segment_running), 1)).performClick()
        compose.onNodeWithText("Morning check").assertExists()
        val prefix = str(R.string.activity_running_for, "").trimEnd()
        compose.onNode(hasContentDescription("$prefix 1:", substring = true)).assertExists()
    }

    @Test
    fun doneOffersUndoForAnEligibleMemoryChange() {
        showActivity()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_cd_count, str(R.string.activity_segment_done), 1)).performClick()
        val changeDesc = str(R.string.activity_change_add, "Likes tea")
        compose.onNodeWithContentDescription(str(R.string.activity_undo_item, changeDesc)).performClick()
        assertEquals("c1", undone)
    }

    @Test
    fun emptySegmentsSayWhatGoesThere() {
        showActivity(ActivityUiState(loaded = true))
        compose.onNodeWithText(str(R.string.activity_empty_needs_title)).assertExists()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_running)).performClick()
        compose.onNodeWithText(str(R.string.activity_empty_running_title)).assertExists()
        compose.onNodeWithContentDescription(str(R.string.activity_segment_done)).performClick()
        compose.onNodeWithText(str(R.string.activity_empty_done_title)).assertExists()
    }

    private fun showSettings(onSignOut: () -> Unit = {}, onDisconnect: () -> Unit = {}) {
        compose.setContent {
            ReiTheme {
                CompositionLocalProvider(LocalShell provides ShellController(Destination.Settings, DrawerMode.Modal, {}, {}, {})) {
                    SettingsIndex(ReiApi("http://127.0.0.1:1"), "http://127.0.0.1:1", ThemePreference.System, {}, onSignOut, onDisconnect)
                }
            }
        }
    }

    @Test
    fun theSettingsIndexHasEveryGroupAndRow() {
        showSettings()
        listOf(
            R.string.settings_group_app, R.string.settings_page_appearance, R.string.settings_page_notifications,
            R.string.settings_show_details, R.string.settings_check_updates,
            R.string.settings_group_security, R.string.settings_page_devices, R.string.settings_page_passkeys, R.string.settings_page_two_factor,
            R.string.settings_group_workspace, R.string.settings_page_general, R.string.settings_page_memory, R.string.settings_page_triggers, R.string.settings_page_usage,
            R.string.settings_group_models_providers, R.string.settings_page_models, R.string.settings_page_providers, R.string.settings_page_runtime,
            R.string.settings_group_capabilities, R.string.settings_page_permissions, R.string.settings_page_connectors, R.string.settings_page_skills, R.string.settings_page_plugins,
            R.string.settings_group_session, R.string.settings_sign_out_row, R.string.settings_disconnect_row,
        ).forEach { compose.onNodeWithText(str(it)).performScrollTo().assertExists() }
        compose.onNodeWithText(str(R.string.settings_page_providers)).performScrollTo()
        // Every settings page is native now, so no row hands off to the web app.
        compose.onAllNodesWithOpensInWeb().assertCountEquals(0)
    }

    @Test
    fun checkForUpdatesShowsTheVersionAndSaysWhenChecksAreOff() {
        assumeTrue("Needs a build without an update feed", BuildConfig.UPDATE_FEED_URL.isEmpty())
        showSettings()
        compose.onNodeWithText(str(R.string.settings_check_updates)).performScrollTo().assertExists()
        compose.onNodeWithText(updateSummary(false, UpdateState.Idle, BuildConfig.VERSION_NAME).asString(context)).performScrollTo().assertExists()
    }

    @Test
    fun disconnectAsksFirstAndSaysWhatHappens() {
        var disconnected = 0
        showSettings(onDisconnect = { disconnected++ })
        compose.onNodeWithText(str(R.string.settings_disconnect_row)).performScrollTo().performClick()
        compose.onNodeWithText(str(R.string.settings_disconnect_confirm_title)).assertExists()
        compose.onNodeWithText(str(R.string.settings_disconnect_confirm_body)).assertExists()
        compose.onNodeWithText(str(R.string.common_cancel)).performClick()
        assertEquals(0, disconnected)
        compose.onNodeWithText(str(R.string.settings_disconnect_row)).performScrollTo().performClick()
        compose.onNodeWithText(str(R.string.settings_disconnect_action)).performClick()
        assertEquals(1, disconnected)
    }

    @Test
    fun signOutAsksFirst() {
        var signedOut = 0
        showSettings(onSignOut = { signedOut++ })
        compose.onNodeWithText(str(R.string.settings_sign_out_row)).performScrollTo().performClick()
        compose.onNodeWithText(str(R.string.settings_sign_out_confirm_title)).assertExists()
        compose.onNodeWithText(str(R.string.settings_sign_out_action)).performClick()
        assertEquals(1, signedOut)
    }

    @Test
    fun appearanceAppliesTheChoiceAtOnce() {
        var chosen: ThemePreference? = null
        compose.setContent {
            ReiTheme {
                CompositionLocalProvider(LocalShell provides ShellController(Destination.Settings, DrawerMode.Modal, {}, {}, {})) {
                    AppearanceScreen(ThemePreference.System, { chosen = it }, {})
                }
            }
        }
        compose.onNodeWithText(str(R.string.theme_system)).assertIsSelected()
        compose.onNodeWithText(str(R.string.theme_dark)).performClick()
        assertEquals(ThemePreference.Dark, chosen)
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithOpensInWeb() = onAllNodesWithContentDescription("Opens in web")
