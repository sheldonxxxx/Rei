package dev.rei.android.ui.components

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * How a chip or attachment anywhere in the app opens a Library file or a Knowledge page. The shell provides it, so a chat
 * reference opens the native viewer or page view; where nothing provides it (previews, tests) it is null and callers fall
 * back to the instance's web route.
 */
interface WorkspaceOpener {
    /** Opens the file viewer. [versionId] pins a version (a chat attachment); null opens the current one. */
    fun openFile(fileId: String, versionId: String? = null)

    fun openPage(pageId: String)

    /** Opens an empty page editor (the Knowledge list's "New page"). */
    fun newPage() {}
}

val LocalWorkspaceOpener = staticCompositionLocalOf<WorkspaceOpener?> { null }
