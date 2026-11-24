package dev.rei.android.feature.library

import dev.rei.android.ui.icons.ReiIcons
import org.junit.Assert.assertSame
import org.junit.Test

class FileIconTest {
    @Test fun plainTextAndProseUseFileText() {
        assertSame(ReiIcons.Page, fileIcon("notes.txt", "text/plain"))
        assertSame(ReiIcons.Page, fileIcon("readme.md", "text/markdown"))
        assertSame(ReiIcons.Page, fileIcon("server.log", "application/octet-stream"))
    }

    @Test fun sourceFilesUseCode() {
        assertSame(ReiIcons.Code, fileIcon("main.py", "text/x-python"))
        assertSame(ReiIcons.Code, fileIcon("data.json", "application/json"))
        assertSame(ReiIcons.Code, fileIcon("index.html", "text/html"))
    }

    @Test fun otherTypesKeepTheirIcons() {
        assertSame(ReiIcons.Spreadsheet, fileIcon("a.xlsx", ""))
        assertSame(ReiIcons.Presentation, fileIcon("a.pptx", ""))
        assertSame(ReiIcons.Image, fileIcon("a.png", "image/png"))
        assertSame(ReiIcons.File, fileIcon("a.pdf", "application/pdf"))
    }
}
