package dev.rei.android.ui.components.workspace

import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.grid.LazyGridState
import dev.rei.android.ui.components.LocalSnackbarClearance
import dev.rei.android.ui.theme.ReiShapes

/**
 * The extended FAB of a workspace screen ("Upload", "New page"). It shrinks to its icon while the list scrolls down and
 * comes back when it scrolls up or reaches the top. The label doubles as the content description in both states.
 */
@Composable
fun ReiFab(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    expanded: Boolean,
    modifier: Modifier = Modifier,
) {
    val setClearance = LocalSnackbarClearance.current
    DisposableEffect(Unit) {
        setClearance(84.dp)
        onDispose { setClearance(0.dp) }
    }
    ExtendedFloatingActionButton(
        onClick = onClick,
        expanded = expanded,
        icon = { Icon(icon, contentDescription = null) },
        text = { Text(label) },
        modifier = modifier.semantics { contentDescription = label },
        shape = ReiShapes.Pill,
        containerColor = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        elevation = FloatingActionButtonDefaults.elevation(),
    )
}

/** True while the list is at its top or its last scroll went up: the FAB stays extended. */
@Composable
fun LazyListState.fabExpanded(): Boolean = rememberFabExpanded({ firstVisibleItemIndex }, { firstVisibleItemScrollOffset })

@Composable
fun LazyGridState.fabExpanded(): Boolean = rememberFabExpanded({ firstVisibleItemIndex }, { firstVisibleItemScrollOffset })

@Composable
private fun rememberFabExpanded(index: () -> Int, offset: () -> Int): Boolean {
    var expanded by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        var lastIndex = index()
        var lastOffset = offset()
        snapshotFlow { index() to offset() }.collect { (i, o) ->
            val up = if (lastIndex != i) lastIndex > i else lastOffset >= o
            val atTop = i == 0 && o == 0
            lastIndex = i
            lastOffset = o
            expanded = atTop || up
        }
    }
    return expanded
}
