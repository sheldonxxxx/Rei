package dev.rei.android.ui.components

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Rule
import org.junit.Test

class MarkdownFormatsTest {
    @get:Rule
    val compose = createComposeRule()

    private val api = ReiApi("http://127.0.0.1:1")

    private fun show(text: String, caret: Boolean = false) = compose.setContent { ReiTheme { ReiMarkdown(text, api, caret = caret) } }

    private fun absent(text: String) = compose.onAllNodesWithText(text, substring = true).assertCountEquals(0)

    @Test
    fun aCalloutShowsItsLabelNotTheMarker() {
        show("> [!NOTE]\n> Useful context.\n\n> [!WARNING] Back up first\n> Then upgrade.")
        compose.onNodeWithText("Note").assertExists()
        compose.onNodeWithText("Useful context.").assertExists()
        compose.onNodeWithText("Back up first").assertExists()
        absent("[!NOTE]")
        absent("[!WARNING]")
    }

    @Test
    fun aFoldedCalloutOpensOnTap() {
        show("> [!TIP]- Details\n> Hidden at first.")
        absent("Hidden at first.")
        compose.onNodeWithText("Details").performClick()
        compose.onNodeWithText("Hidden at first.").assertExists()
    }

    @Test
    fun taskItemsShowACheckboxAndChips() {
        show("- [x] Ship the build\n- [ ] Review it @writer 📅 2000-01-01")
        compose.onNodeWithContentDescription("Task: Ship the build").assertIsOn()
        compose.onNodeWithContentDescription("Task: Review it @writer 📅 2000-01-01").assertIsOff()
        compose.onNodeWithText("@writer", substring = true).assertExists()
        absent("[ ]")
        absent("[x]")
    }

    @Test
    fun strikethroughDropsTheTildes() {
        show("Keep ~~this~~ text")
        compose.onNodeWithText("Keep this text").assertExists()
        absent("~~")
    }

    @Test
    fun aMermaidFenceShowsItsSourceWhileTheReplyStreams() {
        show("```mermaid\ngraph TD\n  A --> B\n```", caret = true)
        compose.onNodeWithText("A --> B", substring = true).assertExists()
        compose.onAllNodesWithContentDescription("Show source").assertCountEquals(0)
    }

    @Test
    fun aMermaidFenceIsDrawnWhenComplete() {
        show("```mermaid\ngraph TD\n  A --> B\n```")
        compose.waitUntil(timeoutMillis = 30_000) {
            compose.onAllNodesWithContentDescription("Show source").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Diagram").assertExists()
        compose.onNodeWithContentDescription("Show source").performClick()
        compose.onNodeWithText("A --> B", substring = true).assertExists()
    }

    @Test
    fun aBrokenMermaidDiagramShowsItsSourceWithANote() {
        show("```mermaid\ngraph TD\n  A --> {{{\n```")
        compose.waitUntil(timeoutMillis = 30_000) {
            compose.onAllNodesWithText("This diagram has a syntax error", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("A --> {{{", substring = true).assertExists()
    }
}
