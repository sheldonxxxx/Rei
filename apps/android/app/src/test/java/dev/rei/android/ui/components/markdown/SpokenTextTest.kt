package dev.rei.android.ui.components.markdown

import org.junit.Assert.assertEquals
import org.junit.Test

class SpokenTextTest {
    @Test
    fun dropsFencesTableRulesAndPipes() {
        val input = "```kotlin\nfun add(a: Int, b: Int) = a + b\n```\n\n| Fruit | Price |\n|:--|--:|\n| Apple | 30 |"
        assertEquals("fun add(a: Int, b: Int) = a + b\nFruit, Price\nApple, 30", spokenText(input))
    }

    @Test
    fun keepsLinkTextAndRemovesMarks() {
        val input = "## Result\n**Bold** and _plain_ [pricing](https://example.com/p)[^cost].\n- one\n> quoted"
        assertEquals("Result\nBold and _plain_ pricing.\none\nquoted", spokenText(input))
    }

    @Test
    fun footnoteDefinitionsReadAsSentences() {
        assertEquals("Cheaper.\nVendor price list, pricing page.", spokenText("Cheaper.[^a]\n\n[^a]: Vendor price list, [pricing page](https://example.com/)."))
    }
}
