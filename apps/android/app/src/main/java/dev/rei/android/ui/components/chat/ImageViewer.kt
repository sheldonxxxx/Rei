package dev.rei.android.ui.components.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ZoomableImage
import dev.rei.android.ui.components.markdown.PictureSource
import dev.rei.android.ui.components.markdown.loadPicture
import dev.rei.android.ui.icons.ReiIcons

/** An image from a message, full screen on black ([ZoomableImage]: pinch, pan, double-tap), Back to close. */
@Composable
fun ImageViewer(api: ReiApi, source: PictureSource, onDismiss: () -> Unit) =
    ImageViewer(source.caption, onDismiss, key = source) { loadPicture(api, source.destination, 2400) }

/** The same viewer for any image: [load] fetches it, [caption] names it, [key] reloads it when it changes. */
@Composable
fun ImageViewer(caption: String, onDismiss: () -> Unit, key: Any, load: suspend () -> ImageBitmap?) {
    val loaded by produceState<Pair<Boolean, ImageBitmap?>>(false to null, key) { value = true to load() }
    val image = loaded.second
    val failed = loaded.first && image == null
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.94f)), contentAlignment = Alignment.Center) {
            val bitmap = image
            if (bitmap != null) {
                ZoomableImage(bitmap, caption.ifBlank { stringResource(R.string.common_image) })
            } else if (failed) {
                Text(stringResource(R.string.common_image_failed), color = Color.White, style = MaterialTheme.typography.bodyLarge)
            } else {
                CircularProgressIndicator(color = Color.White)
            }
            Column(Modifier.align(Alignment.TopStart).statusBarsPadding().padding(8.dp)) {
                ReiIconButton(ReiIcons.Close, stringResource(R.string.common_close_image), onDismiss, tint = Color.White)
            }
            if (caption.isNotBlank()) {
                Text(
                    caption,
                    Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(24.dp),
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}
