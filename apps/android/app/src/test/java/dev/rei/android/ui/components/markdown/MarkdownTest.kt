package dev.rei.android.ui.components.markdown

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    @Test
    fun citationsOrderByFirstUseAndLeaveFencedCodeAlone() {
        val input = """
            A result[^second] repeats[^second] and another[^first].

            ~~~md
            [^example]: This stays inside the sample.
            ~~~

            [^first]: [Rei](https://example.com/)
            [^second]: [History](page:history#section)
                [Pinned sample](file:file-id@version-id)
        """.trimIndent()
        val parsed = markdownWithCitations(input)
        assertEquals(listOf("second", "first"), parsed.citations.keys.toList())
        assertEquals("[History](page:history#section)\n[Pinned sample](file:file-id@version-id)", parsed.citations["second"])
        assertTrue(parsed.body.contains("[^example]:"))
        assertFalse(parsed.body.contains("[^first]:"))
    }

    @Test
    fun externalLinkPolicyDisallowsExecutableAndCredentialUrls() {
        assertTrue(isExternalMarkdownLink("https://example.com/docs"))
        assertTrue(isExternalMarkdownLink("mailto:help@example.com"))
        assertFalse(isExternalMarkdownLink("javascript:alert(1)"))
        assertFalse(isExternalMarkdownLink("file:///data/data"))
        val credentialUrl = java.net.URI("https", "test:fixture", "example.com", -1, "/", null, null)
        assertFalse(isExternalMarkdownLink(credentialUrl.toString()))
        assertFalse(isExternalMarkdownLink("mailto:help@example.com\n"))
    }

    @Test
    fun referencesParseFilesAndPages() {
        assertEquals(Reference.File("file-id", "version-id"), parseReference("file:file-id@version-id"))
        assertEquals(Reference.Page("history", "section"), parseReference("page:history#section"))
        assertEquals(Reference.Page("history", ""), parseReference("page:history"))
        assertEquals(null, parseReference("https://example.com/"))
    }
}
