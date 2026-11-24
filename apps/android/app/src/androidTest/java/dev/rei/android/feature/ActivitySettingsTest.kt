package dev.rei.android.feature

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import dev.rei.android.BuildConfig
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
import dev.rei.android.feature.settings.SettingsScreen
import dev.rei.android.shell.Destination
import dev.rei.android.shell.DrawerMode
import dev.rei.android.shell.LocalShell
import dev.rei.android.shell.ShellController
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.ThemePreference
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Background Activity and Settings, found the way TalkBack finds them: by content description and text. */
class ActivitySettingsTest {
    @get:Rule
    val compose = createComposeRule()

    private val approval = ReiApproval(
        "ap1", 1, "s1", "Research", "send_email", "mail", "send", "write", "ana@example.com", "send the summary to Ana", "{}",
        listOf("once", "session"), "pending", emptyList(), 0, null, null, false, null,
    )
    private val failedJob = BackgroundJob("j1", "memory.review", "s1", "failed", 1, 2, "Model unavailable", "Planning", "Rei", "m")
    private val reviewed = BackgroundJob("j2", "memory.review", "s1", "succeeded", 1, 2, null, "Planning", "Rei", "m")
    private val change = MemoryChange("c1", "add", null, "Likes tea", undoable = true, undone = false)

    private val feed = ActivityFeed(
        needs = listOf(ApprovalRow(approval), FailureRow("job:j1", "Memory review", "Model unavailable", "s1", RetryTarget.Job("j1"))),
        running = listOf(RunningRow("run:r1", "Morning check", "Trigger run", System.currentTimeMillis() - 65_000, "s2")),
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
        compose.onNodeWithContentDescription("Needs you, 2").assertIsSelected()
        compose.onNodeWithContentDescription("Running, 1").assertExists()
        compose.onNodeWithContentDescription("Done, 1").assertExists()
        compose.onNodeWithText("Approval needed").assertExists()
    }

    @Test
    fun aFailureOffersRetryAndOpensItsChat() {
        showActivity()
        compose.onNodeWithContentDescription("Retry Memory review").performClick()
        assertEquals("job:j1", retried)
        compose.onNodeWithText("Model unavailable").performClick()
        assertEquals("s1", opened)
    }

    @Test
    fun runningShowsElapsedTimeInTabularFigures() {
        showActivity()
        compose.onNodeWithContentDescription("Running, 1").performClick()
        compose.onNodeWithText("Morning check").assertExists()
        compose.onNode(hasContentDescription("Running for 1:", substring = true)).assertExists()
    }

    @Test
    fun doneOffersUndoForAnEligibleMemoryChange() {
        showActivity()
        compose.onNodeWithContentDescription("Done, 1").performClick()
        compose.onNodeWithContentDescription("Undo Added: Likes tea").performClick()
        assertEquals("c1", undone)
    }

    @Test
    fun emptySegmentsSayWhatGoesThere() {
        showActivity(ActivityUiState(loaded = true))
        compose.onNodeWithText("Nothing needs you").assertExists()
        compose.onNodeWithContentDescription("Running").performClick()
        compose.onNodeWithText("Nothing running").assertExists()
        compose.onNodeWithContentDescription("Done").performClick()
        compose.onNodeWithText("Nothing finished yet").assertExists()
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
            "App", "Appearance", "Notifications", "Show details by default", "Check for updates", "Security", "Devices", "Passkeys",
            "Rei", "Memory", "Triggers", "Usage", "General", "Providers", "Models", "Runtime", "Plugins", "Skills", "Connectors", "Permissions",
            "Session", "Sign out of this device", "Disconnect server",
        ).forEach { compose.onNodeWithText(it).performScrollTo().assertExists() }
        compose.onNodeWithText("Providers").performScrollTo()
        compose.onAllNodesWithOpensInWeb().assertCountEquals(8)
    }

    @Test
    fun checkForUpdatesShowsTheVersionAndSaysWhenChecksAreOff() {
        assumeTrue("Needs a build without an update feed", BuildConfig.UPDATE_FEED_URL.isEmpty())
        showSettings()
        compose.onNodeWithText("Check for updates").performScrollTo().assertExists()
        compose.onNodeWithText("Version ${BuildConfig.VERSION_NAME} · Update checks are off in this build").performScrollTo().assertExists()
    }

    @Test
    fun disconnectAsksFirstAndSaysWhatHappens() {
        var disconnected = 0
        showSettings(onDisconnect = { disconnected++ })
        compose.onNodeWithText("Disconnect server").performScrollTo().performClick()
        compose.onNodeWithText("Disconnect from this server?").assertExists()
        compose.onNodeWithText("This signs this device out and forgets the server address.", substring = true).assertExists()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(0, disconnected)
        compose.onNodeWithText("Disconnect server").performScrollTo().performClick()
        compose.onNodeWithText("Disconnect").performClick()
        assertEquals(1, disconnected)
    }

    @Test
    fun signOutAsksFirst() {
        var signedOut = 0
        showSettings(onSignOut = { signedOut++ })
        compose.onNodeWithText("Sign out of this device").performScrollTo().performClick()
        compose.onNodeWithText("Sign out of this device?").assertExists()
        compose.onNodeWithText("Sign out").performClick()
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
        compose.onNodeWithText("System").assertIsSelected()
        compose.onNodeWithText("Dark").performClick()
        assertEquals(ThemePreference.Dark, chosen)
    }

    @Test
    fun returningFromSubScreenKeepsScrollPosition() {
        compose.setContent {
            ReiTheme {
                CompositionLocalProvider(LocalShell provides ShellController(Destination.Settings, DrawerMode.Modal, {}, {}, {})) {
                    Box(Modifier.size(360.dp, 400.dp)) {
                        SettingsScreen(
                            api = ReiApi("http://127.0.0.1:1"),
                            serverUrl = "http://127.0.0.1:1",
                            themePreference = ThemePreference.System,
                            onThemePreference = {},
                            onSignOut = {},
                            onDisconnect = {},
                            onOpenActivity = {},
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("Plugins").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Plugins").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Plugins").assertIsDisplayed()
        compose.onNodeWithText("Settings").assertIsNotDisplayed()
    }
}

private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithOpensInWeb() = onAllNodesWithContentDescription("Opens in web")
