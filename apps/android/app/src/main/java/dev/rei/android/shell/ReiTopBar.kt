package dev.rei.android.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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

/**
 * The top bar every destination uses. It sits on the canvas color and shows a 1dp border only while [scrolled] (content
 * is under it). The leading icon opens the drawer, and is left out when the drawer is permanent; a sub-screen passes
 * [onBack] to get a back arrow instead.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReiTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    scrolled: Boolean = false,
    onBack: (() -> Unit)? = null,
    /** Sits before the title (the chat's agent avatar). */
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val shell = LocalShell.current
    Column(modifier) {
        TopAppBar(
            title = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    leading?.invoke()
                    Column(Modifier.weight(1f, fill = false)) {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge)
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
                    shell.showsMenuButton -> ReiIconButton(ReiIcons.Menu, "Open navigation", shell::openDrawer)
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
}
