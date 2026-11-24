package dev.rei.android.ui.components.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyntaxHighlightTest {
    private fun kinds(code: String, language: String) = tokenizeCode(code, language).filter { it.kind != TokenKind.Plain }.map { it.kind to it.text }

    @Test
    fun tokensCoverTheWholeInputInOrder() {
        val code = "val x = 42 // answer\nprintln(\"hi\")"
        assertEquals(code, tokenizeCode(code, "kotlin").joinToString("") { it.text })
    }

    @Test
    fun marksKeywordsNumbersStringsAndComments() {
        val tokens = kinds("fun main() { return 7 } // done", "kotlin")
        assertTrue(TokenKind.Keyword to "fun" in tokens)
        assertTrue(TokenKind.Keyword to "return" in tokens)
        assertTrue(TokenKind.Number to "7" in tokens)
        assertTrue(TokenKind.Comment to "// done" in tokens)
        assertTrue(kinds("name = \"Rei\"", "python").contains(TokenKind.Str to "\"Rei\""))
    }

    @Test
    fun commentStyleFollowsTheLanguage() {
        assertTrue(kinds("x = 1 # note", "python").contains(TokenKind.Comment to "# note"))
        assertTrue(kinds("select 1 -- note", "sql").contains(TokenKind.Comment to "-- note"))
        assertTrue(kinds("a // b", "json").none { it.first == TokenKind.Comment })
    }

    @Test
    fun anUnterminatedStringOrBlockCommentDoesNotThrow() {
        assertEquals("\"open", tokenizeCode("\"open", "").joinToString("") { it.text })
        assertEquals("/* open", tokenizeCode("/* open", "c").joinToString("") { it.text })
    }
}
