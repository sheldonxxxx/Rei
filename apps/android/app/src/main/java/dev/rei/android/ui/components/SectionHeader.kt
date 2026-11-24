package dev.rei.android.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons

/** A small supporting-text label above a group ("Agents", "Chats", "Today"). An [action] icon button sits at its end. */
@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            title,
            modifier = Modifier.padding(top = 16.dp, bottom = 8.dp).semantics { heading() },
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        action?.invoke()
    }
}

@ReiPreviews
@Composable
private fun SectionHeaderPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column {
        SectionHeader("Agents", action = { ReiIconButton(ReiIcons.Plus, "New agent", {}) })
        SectionHeader("Today")
    }
}
