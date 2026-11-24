package dev.rei.android.data

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * "Something in the workspace changed": the viewer and the page view say so after a Trash, a favorite or a save, and the
 * Library and Knowledge lists refresh quietly. One process-wide signal; nothing is carried but the fact.
 */
object WorkspaceChanges {
    private val filesFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    private val pagesFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    val files: SharedFlow<Unit> get() = filesFlow
    val pages: SharedFlow<Unit> get() = pagesFlow

    fun filesChanged() { filesFlow.tryEmit(Unit) }

    fun pagesChanged() { pagesFlow.tryEmit(Unit) }
}
