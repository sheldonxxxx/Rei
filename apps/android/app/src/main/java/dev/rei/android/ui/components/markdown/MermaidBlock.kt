package dev.rei.android.ui.components.markdown

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.AssetManager
import android.net.Uri
import android.util.LruCache
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import dev.rei.android.R
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.copyToClipboard
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.IOException

private const val MermaidHost = "rei-mermaid.invalid"
private const val MermaidOrigin = "https://$MermaidHost"

/** What a diagram came to: its height in dp, or one of the two reasons it is shown as code. */
private sealed interface MermaidResult {
    data class Drawn(val height: Int) : MermaidResult
    data object SyntaxError : MermaidResult
    data object Unavailable : MermaidResult
}

/**
 * Results by theme and source, so a diagram scrolled back into a chat reserves its height at once and a broken one does
 * not start a WebView again.
 */
private val results = LruCache<String, MermaidResult>(64)

/** False when this device has no usable WebView (or one too old to message the app); diagrams then stay code. */
@Volatile private var webViewUsable: Boolean? = null

private fun mermaidAvailable(context: Context): Boolean = webViewUsable ?: try {
    WebViewCompat.getCurrentWebViewPackage(context) != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
} catch (_: Exception) {
    false
}.also { webViewUsable = it }

/**
 * A closed `mermaid` fence drawn as a diagram, fully offline: the bundled Mermaid build runs in a WebView that can load
 * only its own three files, in strict mode with plain-text labels. Until the diagram is drawn the source shows as code;
 * a syntax error shows the code with a note. Like the web, the header has a show-source toggle and copy.
 */
@Composable
internal fun MermaidBlock(source: String) {
    val context = LocalContext.current
    if (!remember { mermaidAvailable(context) }) return CodeBlock("mermaid", source)
    val colorScheme = MaterialTheme.colorScheme
    val theme = remember(colorScheme) { mermaidTheme(colorScheme) }
    val key = "$theme\n$source"
    var result by remember(key) { mutableStateOf(results.get(key)) }
    when (result) {
        MermaidResult.SyntaxError -> return CodeBlock("mermaid", source, note = stringResource(R.string.markdown_mermaid_syntax_error))
        MermaidResult.Unavailable -> return CodeBlock("mermaid", source)
        else -> Unit
    }
    val height = (result as? MermaidResult.Drawn)?.height
    var showSource by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    val codeClipboardLabel = stringResource(R.string.markdown_clipboard_code_label)
    CodeFrame("mermaid", actions = {
        if (height != null) {
            ReiIconButton(
                ReiIcons.Expand,
                stringResource(R.string.markdown_mermaid_expand),
                { expanded = true },
            )
            ReiIconButton(
                ReiIcons.Code,
                stringResource(if (showSource) R.string.markdown_mermaid_show_diagram else R.string.markdown_mermaid_show_source),
                { showSource = !showSource },
                toggled = showSource,
            )
        }
        ReiIconButton(ReiIcons.Copy, stringResource(R.string.markdown_copy_code), { copyToClipboard(context, codeClipboardLabel, source.trimEnd()) })
    }) {
        if (height == null || showSource) CodeText(AnnotatedString(source.trimEnd()))
        // The WebView stays composed while the source shows, so toggling back does not draw the diagram again.
        val visible = height != null && !showSource
        val diagramDesc = stringResource(R.string.markdown_mermaid_diagram)
        // Clipped: a WebView keeps painting its page outside a zero-height box.
        Box(Modifier.fillMaxWidth().height(if (visible) height!!.dp else 0.dp).clipToBounds()) {
            MermaidView(source, theme, { drawn ->
                results.put(key, drawn)
                result = drawn
            })
            // Touches go to the chat (scrolling, the message sheet), never into the page.
            Box(
                Modifier
                    .matchParentSize()
                    .pointerInput(Unit) {}
                    .semantics {
                        contentDescription = diagramDesc
                        role = Role.Image
                    },
            )
        }
    }
    if (expanded && height != null) {
        FullscreenMermaidDialog(source = source, theme = theme, diagramHeightDp = height, onDismiss = { expanded = false })
    }
}

@Composable
private fun FullscreenMermaidDialog(source: String, theme: String, diagramHeightDp: Int, onDismiss: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var boxSize by remember { mutableStateOf(IntSize.Zero) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                .systemBarsPadding(),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .onSizeChanged { boxSize = it }
                    .pointerInput(source) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            val next = (scale * zoom).coerceIn(1f, 5f)
                            scale = next
                            offset = if (next > 1f) {
                                val maxX = (boxSize.width * (next - 1f)) / 2f
                                val maxY = (boxSize.height * (next - 1f)) / 2f
                                val raw = offset + pan
                                Offset(raw.x.coerceIn(-maxX, maxX), raw.y.coerceIn(-maxY, maxY))
                            } else {
                                Offset.Zero
                            }
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(diagramHeightDp.dp)
                        .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                ) {
                    MermaidView(source, theme, {})
                }
            }
            ReiIconButton(
                ReiIcons.Close,
                stringResource(R.string.markdown_mermaid_close),
                onDismiss,
                modifier = Modifier.align(Alignment.TopEnd).padding(8.dp),
            )
        }
    }
}

@Composable
private fun MermaidView(source: String, theme: String, onResult: (MermaidResult) -> Unit) {
    val latest by rememberUpdatedState(onResult)
    val context = androidx.compose.ui.platform.LocalContext.current
    // A device can have no WebView (disabled or being updated); creating one then throws, so the source shows instead.
    val available = remember { runCatching { WebViewCompat.getCurrentWebViewPackage(context) != null }.getOrDefault(false) }
    if (!available) {
        androidx.compose.runtime.LaunchedEffect(Unit) { latest(MermaidResult.Unavailable) }
        return
    }
    AndroidView(
        factory = { context -> MermaidWebView(context) { latest(it) } },
        update = { it.render(source, theme) },
        onRelease = { it.stopLoading(); it.destroy() },
        modifier = Modifier.fillMaxSize(),
    )
}

/** Mermaid theme variables from the Material scheme, as a JSON object (the same roles the web takes from its tokens). */
private fun mermaidTheme(colors: ColorScheme): String {
    fun hex(color: Color) = "#%06X".format(color.toArgb() and 0xFFFFFF)
    return buildJsonObject {
        put("darkMode", colors.surface.luminance() < 0.5f)
        put("fontFamily", "sans-serif")
        put("background", hex(colors.surfaceContainerLowest))
        put("primaryColor", hex(colors.secondaryContainer))
        put("secondaryColor", hex(colors.surfaceContainer))
        put("tertiaryColor", hex(colors.surfaceContainerLow))
        put("primaryTextColor", hex(colors.onSurface))
        put("secondaryTextColor", hex(colors.onSurface))
        put("tertiaryTextColor", hex(colors.onSurface))
        put("primaryBorderColor", hex(colors.outline))
        put("secondaryBorderColor", hex(colors.outline))
        put("tertiaryBorderColor", hex(colors.outline))
        put("lineColor", hex(colors.onSurfaceVariant))
        put("edgeLabelBackground", hex(colors.surfaceContainerLowest))
    }.toString()
}

/** The page's files, and the only things it can load. */
private val MermaidFiles = mapOf(
    "index.html" to "text/html",
    "render.js" to "text/javascript",
    "mermaid.min.js" to "text/javascript",
)

private class MermaidAssets(private val assets: AssetManager) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        val mime = MermaidFiles[path] ?: return null
        val input = try { assets.open("mermaid/$path") } catch (_: IOException) { return null }
        return WebResourceResponse(
            mime, "utf-8", 200, "OK",
            mapOf(
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
                "Content-Security-Policy" to "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'",
            ),
            input,
        )
    }
}

@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
private class MermaidWebView(context: Context, private val onResult: (MermaidResult) -> Unit) : WebView(context) {
    private var loaded = false
    private var requested: Pair<String, String>? = null
    private var sent: Pair<String, String>? = null
    private val loader = WebViewAssetLoader.Builder()
        .setDomain(MermaidHost)
        .addPathHandler("/mermaid/", MermaidAssets(context.assets))
        .build()

    init {
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            domStorageEnabled = false
            setSupportZoom(false)
            builtInZoomControls = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        isFocusable = false
        isLongClickable = false
        setOnLongClickListener { true }
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, "reiMermaid", setOf(MermaidOrigin)) { _, message, origin, mainFrame, _ ->
                if (mainFrame && origin.toString().trimEnd('/') == MermaidOrigin) message.data?.let(::receive)
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url: Uri = request.url
                val allowed = request.method == "GET" && url.scheme == "https" && url.host == MermaidHost
                return (if (allowed) loader.shouldInterceptRequest(url) else null)
                    ?: WebResourceResponse("text/plain", "utf-8", 404, "Unavailable", emptyMap(), null)
            }

            // The page's renderer process died (or was killed for memory). Handling it keeps the app alive; the source shows instead.
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                onResult(MermaidResult.Unavailable)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (loaded) return
                loaded = true
                requested?.let(::send)
            }
        }
        loadUrl("$MermaidOrigin/mermaid/index.html")
    }

    fun render(source: String, theme: String) {
        val job = source to theme
        if (job == requested) return
        requested = job
        if (loaded) send(job)
    }

    private fun send(job: Pair<String, String>) {
        if (job == sent) return
        sent = job
        // The source travels as a JSON string literal and the theme as a JSON object, never spliced into markup.
        evaluateJavascript("window.reiRender(${JsonPrimitive(job.first)}, ${job.second})", null)
    }

    private fun receive(data: String) {
        val message = try { Json.parseToJsonElement(data) as? JsonObject } catch (_: Exception) { null } ?: return
        when (message["kind"]?.jsonPrimitive?.content) {
            "drawn" -> message["height"]?.jsonPrimitive?.intOrNull?.takeIf { it > 0 }?.let { onResult(MermaidResult.Drawn(it)) }
            "error" -> onResult(MermaidResult.SyntaxError)
            "unavailable" -> onResult(MermaidResult.Unavailable)
        }
    }
}
