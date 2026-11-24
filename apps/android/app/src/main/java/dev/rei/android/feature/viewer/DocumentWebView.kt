package dev.rei.android.feature.viewer

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URLConnection

private const val ViewerHost = "rei-viewer.invalid"

/**
 * The bundled PDF and Office renderer (the `viewer/` build, the same one web uses). It can read only its own assets and
 * the bytes of the one version it was given, so a document never reaches the network.
 */
@Composable
fun DocumentWebView(bytes: ByteArray, name: String, mediaType: String, modifier: Modifier = Modifier) {
    key(bytes) {
        val start = Uri.Builder().scheme("https").authority(ViewerHost).path("/index.html")
            .appendQueryParameter("name", name)
            .appendQueryParameter("type", mediaType).build()
        AndroidView(
            factory = { context -> localViewer(context, bytes, start) },
            modifier = modifier.fillMaxSize(),
            onRelease = { it.stopLoading(); it.destroy() },
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun localViewer(context: Context, document: ByteArray, start: Uri): WebView = WebView(context).apply {
    settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        blockNetworkLoads = true
        domStorageEnabled = false
    }
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val uri = request.url
            val path = uri.path.orEmpty()
            fun unavailable() = WebResourceResponse("text/plain", "utf-8", 404, "Unavailable", emptyMap(), null)
            if (uri.scheme != "https" || uri.authority != ViewerHost || request.method != "GET") return unavailable()
            if (path == "/document-bytes") return response("application/octet-stream", ByteArrayInputStream(document))
            if (path != "/index.html" && !path.startsWith("/assets/") && !path.startsWith("/file-viewer/")) return unavailable()
            if (path.split('/').any { it == ".." || it == "." } || path.contains('\\')) return unavailable()
            val mime = when (File(path).extension.lowercase()) {
                "js", "mjs" -> "text/javascript"
                "css" -> "text/css"
                "wasm" -> "application/wasm"
                "html" -> "text/html"
                "json" -> "application/json"
                else -> URLConnection.guessContentTypeFromName(path) ?: "application/octet-stream"
            }
            return try { response(mime, context.assets.open("viewer$path")) } catch (_: IOException) { unavailable() }
        }
    }
    loadUrl(start.toString())
}

private fun response(mime: String, input: InputStream) = WebResourceResponse(
    mime, null, 200, "OK",
    mapOf(
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff",
        "Content-Security-Policy" to "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; form-action 'none'; base-uri 'none'",
    ),
    input,
)
