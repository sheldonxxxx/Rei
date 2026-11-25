package dev.rei.android

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.data.Message
import dev.rei.android.data.ReiApi
import dev.rei.android.data.TakeoverInfo
import dev.rei.android.shell.Destination
import dev.rei.android.shell.DrawerMode
import dev.rei.android.shell.LocalShell
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.shell.ShellController
import dev.rei.android.ui.components.chat.AssistantBubble
import dev.rei.android.ui.components.chat.Composer
import dev.rei.android.ui.components.chat.ComposerState
import dev.rei.android.ui.components.chat.InlineSurface
import dev.rei.android.ui.components.chat.ReplyActions
import dev.rei.android.ui.components.chat.TakeoverCard
import dev.rei.android.ui.components.chat.UserBubble
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.theme.ReiTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Verifies TalkBack semantics (headings, roles, merged toggles, custom actions), touch targets, RTL, and 200% font scale layouts. */
class AccessibilityLayoutTest {
    @get:Rule
    val compose = createComposeRule()

    private val api = ReiApi("http://127.0.0.1:1")

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun str(id: Int, vararg args: Any) = context.getString(id, *args)

    @Test
    fun topBarAndMarkdownHeadingsCarryHeadingSemantics() {
        compose.setContent {
            ReiTheme {
                CompositionLocalProvider(
                    LocalShell provides ShellController(Destination.Chat, DrawerMode.Modal, {}, {}, {}),
                ) {
                    Column {
                        ReiTopBar("Workspace Title")
                        ReiMarkdown("# Section One\n\nBody paragraph.", api)
                    }
                }
            }
        }
        compose.onNode(isHeading() and androidx.compose.ui.test.hasText("Workspace Title")).assertExists()
        compose.onNode(isHeading() and androidx.compose.ui.test.hasText("Section One")).assertExists()
    }

    @Test
    fun surfaceToggleMergesCheckboxRoleAndLabelWithoutDuplicateNodes() {
        val surface = Json.parseToJsonElement(
            """{
              "surfaceId":"s-toggle","state":"active","sessionId":"ses1","title":"Prefs","revision":1,"protocolVersion":"1.0",
              "message":{"createSurface":{"catalogId":"rei/catalog/1","components":[
                {"id":"root","component":"CheckBox","label":"Enable alerts","value":{"path":"/alerts"}}
              ],"dataModel":{"alerts":false}}}
            }""",
        ).jsonObject
        compose.setContent {
            ReiTheme {
                InlineSurface(api, "ses1", surface)
            }
        }
        val toggleNode = compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Checkbox) and
                androidx.compose.ui.test.hasText("Enable alerts"),
        )
        toggleNode.assertExists().assertIsOff().assertHeightIsAtLeast(48.dp)
    }

    @Test
    fun messageBubblesExposeCustomAccessibilityActionsAndKeepInnerTextReadable() {
        var optionsCalls = 0
        var copyCalls = 0
        var inspectCalls = 0
        val userMsg = Message(id = "u1", role = "user", text = "Check deployment status", status = "sent")
        val assistantMsg = Message(id = "a1", role = "assistant", text = "All checks passed.", status = "done")
        compose.setContent {
            ReiTheme {
                Column {
                    UserBubble(message = userMsg, onLongPress = { optionsCalls++ })
                    AssistantBubble(
                        message = assistantMsg,
                        text = assistantMsg.text,
                        api = api,
                        sessionId = "ses1",
                        agentName = "Rei",
                        onLongPress = { optionsCalls++ },
                        actions = ReplyActions(onCopy = { copyCalls++ }, onInspect = { inspectCalls++ }),
                    )
                }
            }
        }
        compose.onNodeWithText("Check deployment status").assertIsDisplayed()
        compose.onNodeWithText("All checks passed.").assertIsDisplayed()

        val optionsLabel = str(R.string.chat_msg_options)
        val copyLabel = str(R.string.common_copy)
        val inspectLabel = str(R.string.chat_msg_inspect)
        val userActionsNode = compose.onNode(
            SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions) and
                androidx.compose.ui.test.hasAnyDescendant(androidx.compose.ui.test.hasText("Check deployment status")),
        ).fetchSemanticsNode()
        val userActions = userActionsNode.config[SemanticsActions.CustomActions]
        assertTrue(userActions.any { it.label == optionsLabel })
        userActions.first { it.label == optionsLabel }.action()
        assertEquals(1, optionsCalls)

        val assistantActionsNode = compose.onNode(
            SemanticsMatcher.keyIsDefined(SemanticsActions.CustomActions) and
                androidx.compose.ui.test.hasAnyDescendant(androidx.compose.ui.test.hasText("All checks passed.")),
        ).fetchSemanticsNode()
        val assistantActions = assistantActionsNode.config[SemanticsActions.CustomActions]
        assertEquals(listOf(optionsLabel, copyLabel, inspectLabel), assistantActions.map { it.label })
        assistantActions.first { it.label == copyLabel }.action()
        assistantActions.first { it.label == inspectLabel }.action()
        assertEquals(1, copyCalls)
        assertEquals(1, inspectCalls)
    }

    @Test
    fun composerSendTargetIsAtLeast48DpAndPlaceholderIsHiddenFromAccessibility() {
        compose.setContent {
            ReiTheme {
                Composer(
                    state = ComposerState(agentName = "Rei"),
                    onDraftChange = {},
                    onSend = {},
                    onStop = {},
                    onAttach = {},
                    onRemoveAttachment = {},
                    onModel = {},
                    onEffort = {},
                )
            }
        }
        compose.onNodeWithContentDescription(str(R.string.composer_send))
            .assertWidthIsAtLeast(48.dp)
            .assertHeightIsAtLeast(48.dp)
        compose.onNodeWithText(str(R.string.composer_placeholder_agent, "Rei")).assertDoesNotExist()
    }

    @Test
    fun doubleFontScaleLayoutsRemainVisibleWithoutClipping() {
        val takeover = TakeoverInfo(
            id = "tk1",
            url = "https://example.com/very/long/sign-in/path/for/browser-takeover-check",
            title = "Sign in to workspace account before continuing",
            reason = "Please finish the sign-in flow.",
            status = "pending",
        )
        compose.setContent {
            ReiTheme {
                val baseDensity = LocalDensity.current
                CompositionLocalProvider(
                    LocalDensity provides Density(baseDensity.density, fontScale = 2.0f),
                ) {
                    Column(Modifier.width(360.dp)) {
                        TakeoverCard(takeover = takeover, agentName = "Rei", onOpen = {})
                        Composer(
                            state = ComposerState(agentName = "Rei", modelLabel = "Claude Sonnet", effortLabel = "High"),
                            onDraftChange = {},
                            onSend = {},
                            onStop = {},
                            onAttach = {},
                            onRemoveAttachment = {},
                            onModel = {},
                            onEffort = {},
                        )
                    }
                }
            }
        }
        compose.onNodeWithText(str(R.string.chat_takeover_prompt, "Rei")).assertIsDisplayed()
        compose.onNodeWithText(str(R.string.browser_open)).assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        compose.onNodeWithContentDescription(str(R.string.composer_send))
            .assert(SemanticsMatcher("non-empty bounds") { it.boundsInRoot.height > 0f && it.boundsInRoot.width > 0f })
            .assertIsDisplayed()
    }

    @Test
    fun rtlAndDoubleFontScaleLayoutsPreserveControlsAndBounds() {
        val takeover = TakeoverInfo(
            id = "tk-rtl",
            url = "https://example.com/signin",
            title = "Account verification required",
            reason = "Complete sign-in.",
            status = "pending",
        )
        compose.setContent {
            ReiTheme {
                val baseDensity = LocalDensity.current
                CompositionLocalProvider(
                    LocalLayoutDirection provides LayoutDirection.Rtl,
                    LocalDensity provides Density(baseDensity.density, fontScale = 2.0f),
                    LocalShell provides ShellController(Destination.Chat, DrawerMode.Modal, {}, {}, {}),
                ) {
                    Column(Modifier.width(360.dp)) {
                        ReiTopBar(title = "Weekly briefing", onBack = {})
                        TakeoverCard(takeover = takeover, agentName = "Rei", onOpen = {})
                        Composer(
                            state = ComposerState(agentName = "Rei", modelLabel = "Claude Sonnet", effortLabel = "High"),
                            onDraftChange = {},
                            onSend = {},
                            onStop = {},
                            onAttach = {},
                            onRemoveAttachment = {},
                            onModel = {},
                            onEffort = {},
                        )
                    }
                }
            }
        }
        compose.onNodeWithContentDescription(str(R.string.common_back)).assertIsDisplayed()
            .assert(SemanticsMatcher("touch target >= 48dp") {
                val minPx = 48f * it.layoutInfo.density.density
                it.touchBoundsInRoot.width >= minPx - 1f && it.touchBoundsInRoot.height >= minPx - 1f
            })
        compose.onNodeWithText(str(R.string.chat_takeover_prompt, "Rei")).assertIsDisplayed()
        compose.onNodeWithContentDescription(str(R.string.composer_send))
            .assert(SemanticsMatcher("non-empty bounds") { it.boundsInRoot.height > 0f && it.boundsInRoot.width > 0f })
            .assertIsDisplayed()
    }
}
