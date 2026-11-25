package dev.rei.android.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rei.android.R

/** Rei's monochrome cut-paper portrait. Decorative: the name next to it carries the meaning. */
@Composable
fun ReiPortrait(modifier: Modifier = Modifier, size: Dp = 32.dp) {
    Image(
        painterResource(R.drawable.rei_portrait),
        contentDescription = null,
        modifier = modifier.size(size).clip(RoundedCornerShape(percent = 20)),
    )
}

/** The portrait with the "Rei" wordmark: the drawer header and sign-in. */
@Composable
fun ReiWordmark(modifier: Modifier = Modifier, portraitSize: Dp = 32.dp, textSize: Int = 20) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ReiPortrait(size = portraitSize)
        Text(stringResource(R.string.app_name), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleLarge.copy(fontSize = textSize.sp, lineHeight = (textSize + 4).sp))
    }
}

@ReiPreviews
@Composable
private fun ReiWordmarkPreview() = ReiPreviewSurface { ReiWordmark() }
