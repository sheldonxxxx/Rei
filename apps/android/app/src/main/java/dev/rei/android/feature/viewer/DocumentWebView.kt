package dev.rei.android.feature.viewer

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.icons.ReiIcons
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.URLConnection

internal const val ViewerHost = "rei-viewer.invalid"

/** Where a request from the viewer page goes. The viewer reads its own bundled files and the one document it was given. */
internal sealed interface ViewerRoute {
    data object Document : ViewerRoute

    /** A file under `assets/viewer/`; [path] has no leading slash. */
    data class Asset(val path: String) : ViewerRoute

    data object Unavailable : ViewerRoute
}

/** Decides what a request may read. Pure, so the rules run in unit tests: anything that is not a GET to the viewer host over https is refused. */
internal fun viewerRoute(scheme: String?, authority: String?, method: String, path: String): ViewerRoute {
    if (scheme != "https" || authority != ViewerHost || method != "GET") return ViewerRoute.Unavailable
    if (path == "/document-bytes") return ViewerRoute.Document
    if (path != "/index.html" && !path.startsWith("/assets/") && !path.startsWith("/file-viewer/")) return ViewerRoute.Unavailable
    if (path.split('/').any { it == ".." || it == "." } || path.contains('\\') || path.contains('%')) return ViewerRoute.Unavailable
    return ViewerRoute.Asset(path.removePrefix("/"))
}

internal fun viewerMimeType(path: String): String = when (File(path).extension.lowercase()) {
    "js", "mjs" -> "text/javascript"
    "css" -> "text/css"
    "wasm" -> "application/wasm"
    "html" -> "text/html"
    "json" -> "application/json"
    else -> URLConnection.guessContentTypeFromName(path) ?: "application/octet-stream"
}

private const val ViewerCsp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src blob:; font-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; " +
    "frame-src 'self' blob:; form-action 'none'; base-uri 'none'"

/**
 * The bundled PDF and Office renderer (the `viewer/` build, the same one web uses). It can read only its own assets and
 * the bytes of the one version it was given, so a document never reaches the network.
 */
@Composable
fun DocumentWebView(bytes: ByteArray, name: String, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    // A device can have no WebView at all (disabled, or being updated); creating one then throws, so check first.
    var stopped by remember(bytes, name) { mutableStateOf(false) }
    val webView = remember(bytes, name) {
        runCatching {
            if (WebViewCompat.getCurrentWebViewPackage(context) == null) null else localViewer(context, bytes, name) { stopped = true }
        }.getOrNull()
    }
    if (webView == null) {
        EmptyState(ReiIcons.File, "No preview", modifier, body = "This device has no WebView to show documents with. Download the original instead.")
        return
    }
    if (stopped) {
        EmptyState(ReiIcons.File, "Preview stopped", modifier, body = "The document viewer ran out of memory or crashed. Close this and open the file again.")
        DisposableEffect(webView) { onDispose { webView.destroy() } }
        return
    }
    DisposableEffect(webView) { onDispose { webView.stopLoading(); webView.destroy() } }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { webView.onPause() }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { webView.onResume() }
    AndroidView(factory = { webView }, modifier = modifier.fillMaxSize())
}

@SuppressLint("SetJavaScriptEnabled")
private fun localViewer(context: Context, document: ByteArray, name: String, onRenderGone: () -> Unit): WebView {
    val start = Uri.Builder().scheme("https").authority(ViewerHost).path("/index.html").appendQueryParameter("name", name).build()
    val loader = WebViewAssetLoader.Builder()
        .setDomain(ViewerHost)
        .setHttpAllowed(false)
        .addPathHandler("/") { path -> viewerResponse(context, "/$path", document) }
        .build()
    return WebView(context).apply {
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            domStorageEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            // Without this the whole app is killed when the renderer process dies. Returning true keeps it alive.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                onRenderGone()
                return true
            }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                if (request.method != "GET") return unavailable()
                return loader.shouldInterceptRequest(request.url) ?: unavailable()
            }
        }
        loadUrl(start.toString())
    }
}

private fun viewerResponse(context: Context, path: String, document: ByteArray): WebResourceResponse? =
    when (val route = viewerRoute("https", ViewerHost, "GET", path)) {
        ViewerRoute.Document -> response("application/octet-stream", ByteArrayInputStream(document))
        is ViewerRoute.Asset -> try {
            response(viewerMimeType(route.path), context.assets.open("viewer/${route.path}"))
        } catch (_: IOException) {
            null
        }
        ViewerRoute.Unavailable -> null
    }

private fun unavailable() = WebResourceResponse("text/plain", "utf-8", 404, "Unavailable", emptyMap(), null)

private fun response(mime: String, input: InputStream) = WebResourceResponse(
    mime, null, 200, "OK",
    mapOf(
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff",
        "Content-Security-Policy" to ViewerCsp,
    ),
    input,
)
