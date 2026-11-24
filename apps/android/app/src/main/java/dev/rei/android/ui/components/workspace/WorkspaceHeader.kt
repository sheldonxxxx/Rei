package dev.rei.android.ui.components.workspace

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.components.PillField
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

/** One active filter, shown under the search row as a chip that removes itself. */
data class ActiveFilter(val label: String, val onRemove: () -> Unit)

/**
 * The header Library and Knowledge share: a large title, one row with the rounded-full search field and a filter icon
 * button beside it, and the active filters as removable chips. The caller owns the filter sheet ([onFilter]) and the
 * lists, so the header stays the same on both screens. It adds no side padding: it sits inside the list's own content padding.
 */
@Composable
fun WorkspaceHeader(
    title: String,
    query: String,
    onQuery: (String) -> Unit,
    searchLabel: String,
    onFilter: () -> Unit,
    filters: List<ActiveFilter>,
    modifier: Modifier = Modifier,
    filterLabel: String = "Filters",
    trailing: (@Composable () -> Unit)? = null,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                title,
                Modifier.weight(1f).semantics { heading() },
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
            trailing?.invoke()
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            PillField(
                value = query,
                onValueChange = onQuery,
                placeholder = searchLabel,
                description = searchLabel,
                leadingIcon = ReiIcons.Search,
                modifier = Modifier.weight(1f),
                keyboardActions = KeyboardActions.Default,
            )
            Box(contentAlignment = Alignment.TopEnd) {
                ReiIconButton(ReiIcons.Filter, filterLabel, onFilter)
                if (filters.isNotEmpty()) {
                    Box(
                        Modifier
                            .padding(top = 10.dp, end = 10.dp)
                            .size(8.dp)
                            .clip(ReiShapes.Pill)
                            .background(MaterialTheme.colorScheme.primary),
                    )
                }
            }
        }
        AnimatedVisibility(filters.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                filters.forEach { filter -> RemovableChip(filter.label, filter.onRemove) }
            }
        }
    }
}

/** A filter or tag chip with a close icon. The whole chip removes it; TalkBack reads "Remove filter: Favorites". */
@Composable
fun RemovableChip(label: String, onRemove: () -> Unit, modifier: Modifier = Modifier, noun: String = "filter") {
    InputChip(
        selected = true,
        onClick = onRemove,
        label = { Text(label) },
        modifier = modifier.semantics { contentDescription = "Remove $noun: $label" },
        shape = ReiShapes.Pill,
        trailingIcon = { Icon(ReiIcons.Close, contentDescription = null, Modifier.size(InputChipDefaults.IconSize)) },
        colors = InputChipDefaults.inputChipColors(
            selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
            selectedLabelColor = MaterialTheme.colorScheme.onSurface,
            selectedTrailingIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
        ),
        border = InputChipDefaults.inputChipBorder(enabled = true, selected = true, selectedBorderColor = MaterialTheme.colorScheme.outlineVariant, selectedBorderWidth = 1.dp),
    )
}

@ReiPreviews
@Composable
private fun WorkspaceHeaderPreview() = ReiPreviewSurface {
    WorkspaceHeader(
        title = "Library",
        query = "",
        onQuery = {},
        searchLabel = "Search library",
        onFilter = {},
        filters = listOf(ActiveFilter("Favorites", {}), ActiveFilter("Images", {})),
    )
}
