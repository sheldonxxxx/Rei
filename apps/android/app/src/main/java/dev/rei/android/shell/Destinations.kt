package dev.rei.android.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.vector.ImageVector
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.ui.icons.ReiIcons

/**
 * Every place the shell can show. The route is the navigation key; [label] is the word used in the drawer and in the top
 * bar (the same words as web: Library, Knowledge, Background Activity). To add a destination, add an entry here and one
 * `destination(...)` line in `ReiNavGraph.kt`.
 */
enum class Destination(val route: String, val label: String, val icon: ImageVector? = null) {
    /** Home. Opening the app lands in the last active chat. */
    Chat("chat", "Chat"),
    Library("library", "Library", ReiIcons.Library),
    Knowledge("knowledge", "Knowledge", ReiIcons.Knowledge),
    Activity("activity", "Background Activity", ReiIcons.Activity),
    Settings("settings", "Settings", ReiIcons.Settings),

    /** Full-screen history search, opened from the drawer header. */
    Search("search", "Search"),
    ;

    companion object {
        fun fromRoute(route: String?): Destination = entries.firstOrNull { it.route == route } ?: Chat
    }
}

/** Phone: modal drawer. Medium: dismissible. Expanded: permanent at 272dp. */
enum class DrawerMode { Modal, Dismissible, Permanent }

/**
 * The shell as destinations see it (`LocalShell.current`): which destination is showing, how the drawer behaves, and the
 * few things a screen may ask of it. Screens use this instead of reaching for the nav controller or the drawer state.
 */
@Stable
class ShellController(
    val current: Destination,
    val drawerMode: DrawerMode,
    private val onOpenDrawer: () -> Unit,
    private val onNavigate: (Destination) -> Unit,
    private val onBack: () -> Unit,
    private val onOpenSettings: (SettingsPage) -> Unit = {},
) {
    /** A permanent drawer needs no menu button. */
    val showsMenuButton: Boolean get() = drawerMode != DrawerMode.Permanent

    fun openDrawer() = onOpenDrawer()

    /** Switches to a top-level destination, keeping the state of the one it leaves. */
    fun navigateTo(destination: Destination) = onNavigate(destination)

    /** Back to the chat, the home destination. */
    fun showChat() = onNavigate(Destination.Chat)

    /** Opens Settings on one of its native pages (the chat's permissions sheet opens Permissions). */
    fun openSettings(page: SettingsPage) = onOpenSettings(page)

    /** Leaves a sub-screen (search, a viewer) the way the system back does. */
    fun back() = onBack()
}

val LocalShell = staticCompositionLocalOf<ShellController> { error("No ShellController: this screen is outside ReiApp") }

@Composable
fun rememberShellController(
    current: Destination,
    drawerMode: DrawerMode,
    onOpenDrawer: () -> Unit,
    onNavigate: (Destination) -> Unit,
    onBack: () -> Unit,
    onOpenSettings: (SettingsPage) -> Unit = {},
): ShellController = androidx.compose.runtime.remember(current, drawerMode, onOpenDrawer, onNavigate, onBack, onOpenSettings) {
    ShellController(current, drawerMode, onOpenDrawer, onNavigate, onBack, onOpenSettings)
}
