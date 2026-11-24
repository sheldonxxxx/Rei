package dev.rei.android.ui.components

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Rule
import org.junit.Test

class MarkdownRenderTest {
    @get:Rule
    val compose = createComposeRule()

    private val api = ReiApi("http://127.0.0.1:8787")

    private fun show(text: String) = compose.setContent { ReiTheme { ReiMarkdown(text, api) } }

    @Test
    fun codeBlocksCarryACopyButtonAndTheirCode() {
        show("Here:\n\n```kotlin\nval answer = 42\n```\n")
        compose.onNodeWithContentDescription("Copy code").assertExists()
        compose.onNodeWithText("val answer = 42", substring = true).assertExists()
    }

    @Test
    fun tablesRenderEveryCell() {
        show("| Name | Count |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |\n")
        listOf("Name", "Count", "Apples", "3", "Pears", "5").forEach { compose.onNodeWithText(it).assertExists() }
    }

    @Test
    fun aCitationNobodyReferencesBecomesASourceChipThatOpensItsNote() {
        show("A claim.\n\n[^a]: [Rei docs](https://example.com/docs)\n")
        compose.onNodeWithText("A claim", substring = true).assertExists()
        compose.onNodeWithText("Source 1").performClick()
        compose.onNodeWithText("Rei docs", substring = true).assertExists()
    }

    @Test
    fun aReferencedCitationKeepsTheSentenceReadable() {
        show("A claim[^a].\n\n[^a]: [Rei docs](https://example.com/docs)\n")
        compose.onNodeWithText("A claim", substring = true).assertExists()
    }

    @Test
    fun plainTextAndListsRender() {
        show("Hello **world**\n\n- one\n- two\n")
        compose.onNodeWithText("Hello world", substring = true).assertExists()
        compose.onNodeWithText("one", substring = true).assertExists()
    }
}
