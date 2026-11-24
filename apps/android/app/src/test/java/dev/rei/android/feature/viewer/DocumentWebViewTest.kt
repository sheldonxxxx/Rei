package dev.rei.android.feature.viewer

import org.junit.Assert.assertEquals
import org.junit.Test

class DocumentWebViewTest {
    private fun route(path: String, scheme: String? = "https", authority: String? = ViewerHost, method: String = "GET") =
        viewerRoute(scheme, authority, method, path)

    @Test
    fun theDocumentAndTheBundledViewerFilesAreServed() {
        assertEquals(ViewerRoute.Document, route("/document-bytes"))
        assertEquals(ViewerRoute.Asset("index.html"), route("/index.html"))
        assertEquals(ViewerRoute.Asset("assets/main-abc.js"), route("/assets/main-abc.js"))
        assertEquals(ViewerRoute.Asset("file-viewer/pdf.worker.mjs"), route("/file-viewer/pdf.worker.mjs"))
    }

    @Test
    fun otherHostsSchemesAndMethodsAreRefused() {
        assertEquals(ViewerRoute.Unavailable, route("/document-bytes", authority = "example.com"))
        assertEquals(ViewerRoute.Unavailable, route("/document-bytes", scheme = "http"))
        assertEquals(ViewerRoute.Unavailable, route("/document-bytes", scheme = "file"))
        assertEquals(ViewerRoute.Unavailable, route("/document-bytes", method = "POST"))
        assertEquals(ViewerRoute.Unavailable, route("/index.html", authority = null))
    }

    @Test
    fun pathsOutsideTheViewerFilesAreRefused() {
        for (path in listOf("/", "/other.html", "/AndroidManifest.xml", "/assets", "/document-bytes/extra")) {
            assertEquals(path, ViewerRoute.Unavailable, route(path))
        }
    }

    @Test
    fun traversalAndEncodedOrBackslashPathsAreRefused() {
        for (path in listOf("/assets/../index.html", "/assets/./a.js", "/assets/..%2Findex.html", "/assets\\a.js", "/file-viewer/../../x")) {
            assertEquals(path, ViewerRoute.Unavailable, route(path))
        }
    }

    @Test
    fun mimeTypesCoverWhatTheRendererLoads() {
        assertEquals("text/javascript", viewerMimeType("assets/a.js"))
        assertEquals("text/javascript", viewerMimeType("file-viewer/w.mjs"))
        assertEquals("application/wasm", viewerMimeType("assets/x.wasm"))
        assertEquals("text/css", viewerMimeType("assets/a.css"))
        assertEquals("text/html", viewerMimeType("index.html"))
        assertEquals("application/octet-stream", viewerMimeType("assets/unknown.bin"))
    }
}
