package dev.rei.android.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.theme.ReiShapes

/**
 * A modal bottom sheet with 28dp top corners on the card color. Back and a swipe down dismiss it; the optional [title]
 * is a heading. Content is a column, so rows (long-press actions, selectors) stack naturally.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReiSheet(
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    title: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        modifier = modifier,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = ReiShapes.Sheet,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
        contentColor = MaterialTheme.colorScheme.onSurface,
        dragHandle = { BottomSheetDefaults.DragHandle() },
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            if (title != null) {
                Text(
                    title,
                    Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                )
            }
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@ReiPreviews
@Composable
private fun ReiSheetPreview() = ReiPreviewSurface {
    // The sheet itself is a window; the preview shows its rows on the card color.
    androidx.compose.material3.Surface(
        shape = ReiShapes.Sheet,
        color = MaterialTheme.colorScheme.surfaceContainerLowest,
    ) {
        Column(Modifier.padding(vertical = 12.dp)) {
            Text("Quarterly report", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
            SettingsRow("Rename", icon = dev.rei.android.ui.icons.ReiIcons.Edit, onClick = {})
            SettingsRow("Pin", icon = dev.rei.android.ui.icons.ReiIcons.Pin, onClick = {})
            SettingsRow("Delete", icon = dev.rei.android.ui.icons.ReiIcons.Trash, onClick = {}, destructive = true)
        }
    }
}
