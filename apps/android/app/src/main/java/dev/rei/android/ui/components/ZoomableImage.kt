package dev.rei.android.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.IntSize

/** A picture that pinches to zoom, pans once zoomed and toggles on double tap. Shared by the chat and the file viewer. */
@Composable
fun ZoomableImage(bitmap: ImageBitmap, description: String, modifier: Modifier = Modifier) {
    var scale by remember(bitmap) { mutableFloatStateOf(1f) }
    var offset by remember(bitmap) { mutableStateOf(Offset.Zero) }
    var containerSize by remember { mutableStateOf(IntSize.Zero) }
    Image(
        bitmap,
        description,
        modifier
            .fillMaxSize()
            .onSizeChanged { containerSize = it }
            .pointerInput(bitmap) {
                detectTapGestures(onDoubleTap = {
                    if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f
                })
            }
            .pointerInput(bitmap) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val zoom = event.calculateZoom()
                        val pan = event.calculatePan()
                        val next = (scale * zoom).coerceIn(1f, 6f)
                        // Pan only while zoomed in, so a vertical swipe never fights the screen around it.
                        if (next > 1f || zoom != 1f) {
                            scale = next
                            offset = if (next > 1f) {
                                val maxX = (containerSize.width * (next - 1f)) / 2f
                                val maxY = (containerSize.height * (next - 1f)) / 2f
                                val raw = offset + pan
                                Offset(raw.x.coerceIn(-maxX, maxX), raw.y.coerceIn(-maxY, maxY))
                            } else {
                                Offset.Zero
                            }
                            event.changes.forEach { if (it.moved()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
        contentScale = ContentScale.Fit,
    )
}

private fun PointerInputChange.moved(): Boolean = position != previousPosition
