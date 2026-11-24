package dev.rei.android.ui.components.markdown

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkTargetTest {
    @Test fun `a page reference opens the page`() {
        assertEquals(LinkTarget.Page("p1"), linkTarget("page:p1"))
        assertEquals(LinkTarget.Page("p1"), linkTarget("page:p1#intro"))
    }

    @Test fun `a file reference opens the file at its version when it has one`() {
        assertEquals(LinkTarget.File("f1", null), linkTarget("file:f1"))
        assertEquals(LinkTarget.File("f1", "v2"), linkTarget("file:f1@v2"))
    }

    @Test fun `outside addresses go to the browser and the rest goes nowhere`() {
        assertEquals(LinkTarget.External("https://example.com/a"), linkTarget("https://example.com/a"))
        assertEquals(LinkTarget.External("mailto:a@example.com"), linkTarget("mailto:a@example.com"))
        assertEquals(LinkTarget.Ignored, linkTarget("https://user:pw@example.com/"))
        assertEquals(LinkTarget.Ignored, linkTarget("javascript:alert(1)"))
        assertEquals(LinkTarget.Ignored, linkTarget("/knowledge/p1"))
    }
}
