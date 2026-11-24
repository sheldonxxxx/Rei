package dev.rei.android.ui.components.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.TakeoverInfo
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.arrive

/**
 * "Rei wants you to take over the browser": an inline card, like an approval, that opens the full-screen browser. Once the
 * takeover is over it settles into one quiet line.
 */
@Composable
fun TakeoverCard(takeover: TakeoverInfo, agentName: String, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    val waiting = takeover.status == "pending"
    val active = takeover.status == "active"
    if (!waiting && !active) {
        NoticeLine(stringResource(R.string.chat_takeover_returned, agentName), modifier)
        return
    }
    Surface(
        modifier.fillMaxWidth().arrive(ReiEnter.Card).semantics { liveRegion = LiveRegionMode.Polite },
        shape = ReiShapes.Card,
        color = colors.tertiaryContainer,
        border = BorderStroke(1.dp, ReiTheme.colors.attentionBorder),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(ReiIcons.Globe, null, Modifier.size(20.dp), tint = colors.onTertiaryContainer)
                Text(
                    if (waiting) stringResource(R.string.chat_takeover_prompt, agentName) else stringResource(R.string.chat_takeover_active),
                    style = MaterialTheme.typography.titleSmall,
                    color = colors.onTertiaryContainer,
                )
            }
            takeover.reason?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyLarge, color = colors.onTertiaryContainer)
            }
            (takeover.title ?: takeover.url)?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onTertiaryContainer, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Button(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.browser_open)) }
        }
    }
}
