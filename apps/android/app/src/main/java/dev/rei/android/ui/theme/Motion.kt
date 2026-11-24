package dev.rei.android.ui.theme

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.node.CompositionLocalConsumerModifierNode
import androidx.compose.ui.node.LayoutModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.currentValueOf
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Constraints
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * `docs/motion.md` for Compose. The kind says what happened, never taste:
 *
 * | kind | for | budget |
 * | --- | --- | --- |
 * | [Rise] | content a run produced is now present (an answer, a tool row, a memory chip) | 180ms, 4dp up |
 * | [Card] | an overlay asking you to act (approval, browser takeover) | 200ms, 6dp up |
 * | [Fade] | punctuation and status (notices, loaded rows, a page's content region) | 180ms, no travel |
 * | [Scale] | a surface taking the screen (dialogs, sheets) | 260ms, 0.98 scale + 6dp |
 *
 * Only alpha and translation move, never size where it would shift the transcript. Leaving is faster than arriving and
 * nothing exceeds [ReiMotion.CeilingMs]. Compose itself scales durations by the system animator duration scale, so
 * callers only branch on `scale <= 0f` for reduced motion rather than multiplying durations by `scale` (which would
 * double-scale as `scale²`).
 */
enum class ReiEnter(val durationMs: Int, val travelDp: Float, val scaleFrom: Float) {
    Rise(180, 4f, 1f),
    Card(200, 6f, 1f),
    Fade(180, 0f, 1f),
    Scale(260, 6f, 0.98f),
}

object ReiMotion {
    /** The Material 3 standard easing. */
    val Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    const val ExitMs = 120
    const val CeilingMs = 300
    const val StepMs = 24
    const val StaggerCapMs = 120

    /** Stagger for the [index]th sibling arriving together, capped so a long list never waits behind itself. */
    fun delayFor(index: Int): Int = (index * StepMs).coerceAtMost(StaggerCapMs)

    /** For `AnimatedVisibility` and `AnimatedContent`. Collapses to no motion when [scale] is 0. */
    fun enter(kind: ReiEnter, scale: Float = 1f, density: Float = 3f): EnterTransition {
        if (scale <= 0f) return EnterTransition.None
        val duration = kind.durationMs.coerceAtMost(CeilingMs)
        val fade = fadeIn(tween(duration, easing = Easing))
        return when (kind) {
            ReiEnter.Fade -> fade
            ReiEnter.Rise, ReiEnter.Card -> fade + slideInVertically(tween(duration, easing = Easing)) {
                (kind.travelDp * density).roundToInt()
            }
            ReiEnter.Scale -> fade + scaleIn(tween(duration, easing = Easing), initialScale = kind.scaleFrom)
        }
    }

    fun exit(scale: Float = 1f): ExitTransition =
        if (scale <= 0f) ExitTransition.None else fadeOut(tween(ExitMs, easing = Easing))
}

/** The system's animator duration scale (Settings → Developer options). 0 means reduced motion. */
val LocalMotionScale = staticCompositionLocalOf { 1f }

/** True once a region has painted its first content, so only what arrives later animates. */
val LocalMotionLive = compositionLocalOf { true }

@Composable
fun rememberAnimatorScale(): Float {
    val context = LocalContext.current
    var scale by remember { mutableFloatStateOf(readScale(context)) }
    DisposableEffect(context) {
        val resolver = context.contentResolver
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                scale = readScale(context)
            }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return scale
}

private fun readScale(context: Context): Float =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f).coerceAtLeast(0f)

/**
 * A region whose first paint must not replay (a chat opening, a list's first page). Everything composed while the region
 * is closed gets no arrival; the region opens after its first frame once [ready], and again whenever [key] changes
 * (another chat, another list). The decision is taken when an item mounts, as on web.
 */
@Composable
fun MotionRegion(key: Any?, ready: Boolean = true, content: @Composable () -> Unit) {
    var live by remember(key) { mutableStateOf(false) }
    LaunchedEffect(key, ready) {
        if (ready) {
            androidx.compose.runtime.withFrameNanos { }
            live = true
        }
    }
    CompositionLocalProvider(LocalMotionLive provides live, content = content)
}

/**
 * Arrival for the element that mounts. [index] staggers siblings. Items that mount while their [MotionRegion] is still
 * closed, and every arrival under an animator scale of 0, appear instantly.
 */
fun Modifier.arrive(kind: ReiEnter, index: Int = 0): Modifier = this then ArriveElement(kind, index)

private data class ArriveElement(val kind: ReiEnter, val index: Int) : ModifierNodeElement<ArriveNode>() {
    override fun create() = ArriveNode(kind, index)
    override fun update(node: ArriveNode) {
        node.kind = kind
        node.index = index
    }
    override fun InspectorInfo.inspectableProperties() {
        name = "arrive"
        properties["kind"] = kind
        properties["index"] = index
    }
}

private class ArriveNode(var kind: ReiEnter, var index: Int) :
    Modifier.Node(),
    CompositionLocalConsumerModifierNode,
    LayoutModifierNode {

    private var progress = Animatable(1f)
    private var started = false

    override fun onReset() {
        started = false
    }

    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val scale = currentValueOf(LocalMotionScale)
        val live = currentValueOf(LocalMotionLive)
        if (!started) {
            started = true
            if (live && scale > 0f) {
                progress = Animatable(0f)
                coroutineScope.launch {
                    val wait = ReiMotion.delayFor(index)
                    if (wait > 0) delay(wait.toLong())
                    progress.animateTo(1f, tween(kind.durationMs.coerceAtMost(ReiMotion.CeilingMs), easing = ReiMotion.Easing))
                }
            } else {
                progress = Animatable(1f)
            }
        }
        val placeable = measurable.measure(constraints)
        return layout(placeable.width, placeable.height) {
            placeable.placeWithLayer(0, 0) {
                val p = if (!live || scale <= 0f) 1f else progress.value
                alpha = p
                translationY = (1f - p) * kind.travelDp * density
                val s = kind.scaleFrom + (1f - kind.scaleFrom) * p
                scaleX = s
                scaleY = s
            }
        }
    }
}
