package dev.rei.android.ui.components

import android.content.res.Configuration
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.theme.ReiTheme

/** Put this on a `@Composable` preview to get the light and the dark Engawa rendering. */
@Preview(name = "Light", showBackground = true, backgroundColor = 0xFFF7F5F1, widthDp = 360)
@Preview(
    name = "Dark",
    showBackground = true,
    backgroundColor = 0xFF1C1A19,
    widthDp = 360,
    uiMode = Configuration.UI_MODE_NIGHT_YES or Configuration.UI_MODE_TYPE_NORMAL,
)
annotation class ReiPreviews

/** The canvas a preview draws on; follows the preview's night mode. */
@Composable
fun ReiPreviewSurface(content: @Composable () -> Unit) {
    ReiTheme {
        Surface(color = MaterialTheme.colorScheme.background) {
            Box(Modifier.padding(16.dp)) { content() }
        }
    }
}
