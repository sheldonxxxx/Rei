package dev.rei.android.feature.library

import android.text.format.DateUtils
import android.util.LruCache
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.ReiApi
import dev.rei.android.feature.viewer.PreviewKind
import dev.rei.android.feature.viewer.fileBytes
import dev.rei.android.feature.viewer.previewKind
import dev.rei.android.feature.viewer.typeLabel
import dev.rei.android.ui.components.markdown.loadPicture
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.tabular

private val sourceExtensions = setOf(
    "sh", "bash", "zsh", "py", "js", "jsx", "ts", "tsx", "css", "scss", "sql", "c", "h", "cpp", "hpp", "java", "go", "rs", "rb",
    "php", "swift", "toml", "yaml", "yml", "json", "jsonl", "xml", "html", "htm",
)

private val SpreadsheetFilePattern = Regex(".*\\.(xls[xmb]?|xltx?|ods|csv|tsv)$")
private val PresentationFilePattern = Regex(".*\\.(pptx?|ppsx?|odp)$")

/**
 * The card's icon for a file: sheets, slides, pictures, source files (code), prose and plain text (file-text), everything
 * else. Web shows the terminal icon for plain text; on Android terminal is for commands only.
 */
fun fileIcon(name: String, mediaType: String): ImageVector {
    val lower = name.lowercase()
    return when {
        SpreadsheetFilePattern.matches(lower) -> ReiIcons.Spreadsheet
        PresentationFilePattern.matches(lower) -> ReiIcons.Presentation
        else -> when (previewKind(name, mediaType)) {
            PreviewKind.Image -> ReiIcons.Image
            PreviewKind.Html -> ReiIcons.Code
            PreviewKind.Text -> if (lower.substringAfterLast('.', "") in sourceExtensions) ReiIcons.Code else ReiIcons.Page
            PreviewKind.Markdown -> ReiIcons.Page
            else -> ReiIcons.File
        }
    }
}

private val thumbnails = LruCache<String, ImageBitmap>(48)
private val thumbnailTypes = setOf("png", "jpg", "jpeg", "gif", "webp", "avif")

/**
 * A card in the Library grid: thumbnail or type icon, the name, then size and date in tabular figures. The whole card is
 * one touch target that opens the viewer; it carries no per-item actions (those live in the viewer's top bar).
 */
@Composable
fun FileCard(file: LibraryFile, api: ReiApi?, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val date = remember(file.updatedAt) { shortDate(context, file.updatedAt) }
    Surface(
        onClick = onOpen,
        modifier = modifier.fillMaxWidth().semantics { role = Role.Button },
        shape = ReiShapes.Card,
        color = ReiTheme.colors.card,
        border = BorderStroke(1.dp, colors.outlineVariant),
    ) {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).background(colors.surfaceContainerLow), contentAlignment = Alignment.Center) {
                FileThumbnail(file, api)
                if (file.favorite) {
                    Icon(
                        ReiIcons.Star,
                        contentDescription = stringResource(R.string.library_file_favorite),
                        Modifier
                            .align(Alignment.TopEnd)
                            .padding(8.dp)
                            .clip(ReiShapes.Pill)
                            .background(ReiTheme.colors.card.copy(alpha = 0.9f))
                            .padding(5.dp)
                            .size(16.dp),
                        tint = colors.tertiary,
                    )
                }
            }
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(file.name, style = MaterialTheme.typography.titleSmall, minLines = 2, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${fileBytes(file.current.size)} · $date",
                    style = MaterialTheme.typography.bodySmall.tabular(),
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun FileThumbnail(file: LibraryFile, api: ReiApi?) {
    val colors = MaterialTheme.colorScheme
    val ext = file.name.substringAfterLast('.', "").lowercase()
    val wantsThumbnail = api != null && ext in thumbnailTypes && previewKind(file.name, file.current.mediaType) == PreviewKind.Image
    val key = "${file.id}@${file.current.versionId}"
    val image by produceState(thumbnails.get(key), key, api) {
        if (wantsThumbnail && value == null) {
            value = loadPicture(api!!, "file:${file.id}@${file.current.versionId}", 480)?.also { thumbnails.put(key, it) }
        }
    }
    val bitmap = image
    if (bitmap != null) {
        Image(bitmap, contentDescription = null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
    } else {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(fileIcon(file.name, file.current.mediaType), contentDescription = null, Modifier.size(36.dp), tint = colors.onSurfaceVariant)
            Text(typeLabel(file.name, stringResource(R.string.library_type_fallback)), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
    }
}

/** "20 Nov", or "20 Nov 2025" when it is not this year. */
internal fun shortDate(context: android.content.Context, millis: Long): String {
    val sameYear = DateUtils.isToday(millis) || java.util.Calendar.getInstance().let { now ->
        val then = java.util.Calendar.getInstance().apply { timeInMillis = millis }
        now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR)
    }
    val flags = DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or (if (sameYear) 0 else DateUtils.FORMAT_SHOW_YEAR)
    return DateUtils.formatDateTime(context, millis, flags)
}
