package dev.rei.android.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch

/** An Undo action hosted in [WorkspaceRepository] so it outlives the screen and rotation that raised the snackbar. */
sealed interface UndoAction {
    data class RestoreFile(val fileId: String) : UndoAction
    data class RestorePage(val pageId: String) : UndoAction
}

/** An app-level snackbar notice emitted by workspace operations. */
data class WorkspaceNotice(
    val message: String,
    val actionLabel: String? = null,
    val undo: UndoAction? = null,
)

/**
 * Coordinates workspace refresh signals (Library files & Knowledge pages) and application-scoped Undo mutations
 * that outlive screen closures and configuration changes.
 */
class WorkspaceRepository(
    private val scope: CoroutineScope,
    private val apiProvider: () -> ReiApi?,
    private val onAuthFailure: (Exception) -> Unit = {},
) {
    private val filesFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    private val pagesFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    private val noticesFlow = MutableSharedFlow<WorkspaceNotice>(extraBufferCapacity = 8)

    val filesChanged: SharedFlow<Unit> = filesFlow.asSharedFlow()
    val pagesChanged: SharedFlow<Unit> = pagesFlow.asSharedFlow()
    val notices: SharedFlow<WorkspaceNotice> = noticesFlow.asSharedFlow()

    fun notifyFilesChanged() {
        filesFlow.tryEmit(Unit)
    }

    fun notifyPagesChanged() {
        pagesFlow.tryEmit(Unit)
    }

    fun showNotice(message: String, undo: UndoAction? = null) {
        noticesFlow.tryEmit(WorkspaceNotice(message, actionLabel = if (undo != null) "Undo" else null, undo = undo))
    }

    fun performUndo(action: UndoAction) {
        val api = apiProvider() ?: return
        scope.launch {
            try {
                when (action) {
                    is UndoAction.RestoreFile -> {
                        api.setFileTrashed(action.fileId, false)
                        notifyFilesChanged()
                    }
                    is UndoAction.RestorePage -> {
                        api.restoreKnowledgePage(action.pageId)
                        notifyPagesChanged()
                    }
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                if (failure is ReiApiException && failure.status in setOf(401, 426)) {
                    onAuthFailure(failure)
                } else {
                    val fallback = when (action) {
                        is UndoAction.RestoreFile -> "Could not restore the file."
                        is UndoAction.RestorePage -> "Could not restore the page."
                    }
                    noticesFlow.tryEmit(WorkspaceNotice(failure.localizedMessage ?: fallback))
                }
            }
        }
    }
}
