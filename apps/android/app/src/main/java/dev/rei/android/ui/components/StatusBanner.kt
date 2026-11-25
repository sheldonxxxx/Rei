package dev.rei.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

enum class StatusKind { Info, Attention, Error }

/**
 * A plain-language state: reconnecting, something failed, something waits. Always paired with a label (never colour
 * alone) and announced politely, or assertively for [StatusKind.Error]. [actionLabel] adds a quiet text action ("Retry").
 */
@Composable
fun StatusBanner(
    text: String,
    modifier: Modifier = Modifier,
    kind: StatusKind = StatusKind.Info,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val container = when (kind) {
        StatusKind.Info -> colors.surfaceContainerHigh
        StatusKind.Attention -> colors.tertiaryContainer
        StatusKind.Error -> colors.errorContainer
    }
    val content = when (kind) {
        StatusKind.Info -> colors.onSurface
        StatusKind.Attention -> colors.onTertiaryContainer
        StatusKind.Error -> colors.onErrorContainer
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = if (kind == StatusKind.Error) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        shape = ReiShapes.Card,
        color = container,
        contentColor = content,
        border = when (kind) {
            StatusKind.Attention -> BorderStroke(1.dp, ReiTheme.colors.attentionBorder)
            StatusKind.Info -> BorderStroke(1.dp, colors.outlineVariant)
            StatusKind.Error -> null
        },
    ) {
        Row(
            Modifier.padding(start = 14.dp, end = if (actionLabel != null) 4.dp else 14.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                when (kind) {
                    StatusKind.Info -> ReiIcons.Info
                    StatusKind.Attention -> ReiIcons.Shield
                    StatusKind.Error -> ReiIcons.Alert
                },
                contentDescription = null,
                modifier = Modifier.size(20.dp),
            )
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            if (actionLabel != null && onAction != null) TextButton(onAction) { Text(actionLabel) }
        }
    }
}

@ReiPreviews
@Composable
private fun StatusBannerPreview() = ReiPreviewSurface {
    androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StatusBanner("Reconnecting to Rei…", actionLabel = "Retry", onAction = {})
        StatusBanner("Approval needed in Research.", kind = StatusKind.Attention)
        StatusBanner("Couldn’t reach Rei. Check your connection and try again.", kind = StatusKind.Error)
    }
}
