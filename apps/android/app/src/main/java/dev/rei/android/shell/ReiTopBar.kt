package dev.rei.android.shell

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.update.UpdateBanner

/**
 * The top bar every destination uses. It sits on the canvas color and shows a 1dp border only while [scrolled] (content
 * is under it). The leading icon opens the drawer, and is left out when the drawer is permanent; a sub-screen passes
 * [onBack] to get a back arrow instead. When [scrolledTitle] is set, it crossfades into the bar while [scrolled].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReiTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    scrolled: Boolean = false,
    scrolledTitle: String? = null,
    onBack: (() -> Unit)? = null,
    /** Sits before the title (the chat's agent avatar). */
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val shell = LocalShell.current
    val shownTitle = if (scrolled && scrolledTitle != null) scrolledTitle else title
    val emptyOnPermanent = !shell.showsMenuButton && onBack == null && leading == null && shownTitle.isEmpty()
    Column(modifier) {
        if (emptyOnPermanent) {
            Spacer(Modifier.statusBarsPadding())
        } else {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        leading?.invoke()
                        Column(Modifier.weight(1f, fill = false)) {
                            Crossfade(targetState = shownTitle, label = "top bar title") { text ->
                                if (text.isNotEmpty()) {
                                    Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge)
                                }
                            }
                            if (subtitle != null) {
                                Text(
                                    subtitle,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                },
                navigationIcon = {
                    when {
                        onBack != null -> ReiIconButton(ReiIcons.Back, "Back", onBack)
                        shell.showsMenuButton -> Box(contentAlignment = Alignment.TopEnd) {
                            ReiIconButton(
                                ReiIcons.Menu,
                                if (shell.attentionCount > 0) "Open navigation, ${shell.attentionCount} need attention" else "Open navigation",
                                shell::openDrawer,
                            )
                            if (shell.attentionCount > 0) {
                                Box(
                                    Modifier
                                        .padding(top = 10.dp, end = 10.dp)
                                        .size(8.dp)
                                        .background(MaterialTheme.colorScheme.tertiary, CircleShape),
                                )
                            }
                        }
                    }
                },
                actions = actions,
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background,
                    scrolledContainerColor = MaterialTheme.colorScheme.background,
                ),
            )
            if (scrolled) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
        UpdateBanner(Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
    }
}
