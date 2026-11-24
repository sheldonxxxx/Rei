package dev.rei.android.feature.viewer

import org.junit.Assert.assertEquals
import org.junit.Test

class PreviewKindTest {
    @Test
    fun knownExtensionsWinOverTheMediaType() {
        assertEquals(PreviewKind.Image, previewKind("photo.PNG", "application/octet-stream"))
        assertEquals(PreviewKind.Pdf, previewKind("report.pdf", "application/octet-stream"))
        assertEquals(PreviewKind.Office, previewKind("budget.xlsx", "application/octet-stream"))
        assertEquals(PreviewKind.Markdown, previewKind("notes.md", "text/plain"))
    }

    @Test
    fun theMediaTypeCoversFilesWithoutAKnownExtension() {
        assertEquals(PreviewKind.Office, previewKind("deck", "application/vnd.openxmlformats-officedocument.presentationml.presentation"))
        assertEquals(PreviewKind.Text, previewKind("readme", "text/plain; charset=utf-8"))
        assertEquals(PreviewKind.Image, previewKind("pic", "image/webp"))
        assertEquals(PreviewKind.Unsupported, previewKind("blob.bin", "application/octet-stream"))
    }

    @Test
    fun sizesReadLikeWeb() {
        assertEquals("512 B", fileBytes(512))
        assertEquals("1.5 KiB", fileBytes(1536))
        assertEquals("2.0 MiB", fileBytes(2L * 1024 * 1024))
        assertEquals("PDF", typeLabel("a.pdf"))
        assertEquals("FILE", typeLabel("noext"))
    }
}
