package dev.rei.android.shell

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import dev.rei.android.feature.settings.ProviderSection
import dev.rei.android.feature.settings.SettingsPage
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.Serializable

/**
 * Top-level drawer destinations. [label] is the word used in the drawer and in the top bar
 * (the same words as web: Library, Knowledge, Background Activity).
 */
enum class Destination(val label: String, val icon: ImageVector? = null) {
    /** Home. Opening the app lands in the last active chat. */
    Chat("Chat"),
    Library("Library", ReiIcons.Library),
    Knowledge("Knowledge", ReiIcons.Knowledge),
    Activity("Background Activity", ReiIcons.Activity),
    Settings("Settings", ReiIcons.Settings),

    /** Full-screen history search, opened from the drawer header. */
    Search("Search"),
    ;

    fun toRoute(): Any = when (this) {
        Chat -> ChatRoute
        Library -> LibraryRoute
        Knowledge -> KnowledgeRoute
        Activity -> ActivityRoute
        Settings -> SettingsRoute
        Search -> SearchRoute
    }

    companion object {
        fun fromNavDestination(destination: NavDestination?): Destination {
            if (destination == null) return Chat
            val chain = destination.hierarchy
            return when {
                chain.any { it.hasRoute<LibraryRoute>() || it.hasRoute<FileViewerRoute>() } -> Library
                chain.any { it.hasRoute<KnowledgeRoute>() || it.hasRoute<KnowledgePageRoute>() } -> Knowledge
                chain.any { it.hasRoute<ActivityRoute>() } -> Activity
                chain.any { it.hasRoute<SearchRoute>() } -> Search
                chain.any {
                    it.hasRoute<SettingsRoute>() ||
                        it.hasRoute<SettingsDetailRoute>() ||
                        it.hasRoute<SettingsTwoFactorRoute>() ||
                        it.hasRoute<SettingsSandboxNetworkRoute>() ||
                        it.hasRoute<SettingsProviderSectionRoute>() ||
                        it.hasRoute<SettingsProviderFormRoute>() ||
                        it.hasRoute<SettingsPluginDetailRoute>() ||
                        it.hasRoute<SettingsPluginEditRoute>() ||
                        it.hasRoute<SettingsConnectorDetailRoute>() ||
                        it.hasRoute<SettingsMemoryHistoryRoute>() ||
                        it.hasRoute<SettingsSkillDetailRoute>() ||
                        it.hasRoute<SettingsTriggerDetailRoute>()
                } -> Settings
                else -> Chat
            }
        }
    }
}

// ---- Type-safe NavHost routes ----------------------------------------------------------------------------------------

@Serializable data object ChatRoute
@Serializable data object LibraryRoute
@Serializable data object KnowledgeRoute
@Serializable data class KnowledgePageRoute(val target: String)
@Serializable data class FileViewerRoute(val fileId: String, val versionId: String? = null)
@Serializable data class BrowserRoute(val sessionId: String)
@Serializable data object ActivityRoute
@Serializable data object SearchRoute

@Serializable data object SettingsRoute
@Serializable data class SettingsDetailRoute(val page: SettingsPage)
@Serializable data object SettingsTwoFactorRoute
@Serializable data object SettingsSandboxNetworkRoute
@Serializable data class SettingsProviderSectionRoute(val section: ProviderSection)
@Serializable data class SettingsProviderFormRoute(val kind: String, val editingId: String? = null)
@Serializable data class SettingsPluginDetailRoute(val pluginId: String)
@Serializable data class SettingsPluginEditRoute(val pluginId: String)
@Serializable data class SettingsConnectorDetailRoute(val connectorId: String, val fromPlugin: Boolean = false)
@Serializable data class SettingsMemoryHistoryRoute(val lineId: String)
@Serializable data class SettingsSkillDetailRoute(val skillId: String)
@Serializable data class SettingsTriggerDetailRoute(val triggerId: String)

/** Phone: modal drawer. Medium: dismissible. Expanded: permanent at 272dp. */
enum class DrawerMode { Modal, Dismissible, Permanent }

/**
 * The shell as destinations see it (`LocalShell.current`): which destination is showing, how the drawer behaves, and the
 * few things a screen may ask of it. Kept as a single stable instance across navigation and resize so [LocalShell]
 * never triggers whole-tree invalidations.
 */
@Stable
class ShellController(
    current: Destination,
    drawerMode: DrawerMode,
    private var onOpenDrawer: () -> Unit,
    private var onNavigate: (Destination) -> Unit,
    private var onBack: () -> Unit,
    private var onOpenSettings: (SettingsPage) -> Unit = {},
) {
    var current by mutableStateOf(current)
        internal set

    var drawerMode by mutableStateOf(drawerMode)
        internal set

    internal fun updateCallbacks(
        onOpenDrawer: () -> Unit,
        onNavigate: (Destination) -> Unit,
        onBack: () -> Unit,
        onOpenSettings: (SettingsPage) -> Unit,
    ) {
        this.onOpenDrawer = onOpenDrawer
        this.onNavigate = onNavigate
        this.onBack = onBack
        this.onOpenSettings = onOpenSettings
    }

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
): ShellController {
    val controller = remember {
        ShellController(current, drawerMode, onOpenDrawer, onNavigate, onBack, onOpenSettings)
    }
    controller.current = current
    controller.drawerMode = drawerMode
    controller.updateCallbacks(onOpenDrawer, onNavigate, onBack, onOpenSettings)
    return controller
}
