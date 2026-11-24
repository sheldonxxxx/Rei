package dev.rei.android.feature.viewer

import android.content.ContentResolver
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.LibraryDetail
import dev.rei.android.data.LibraryVersion
import dev.rei.android.data.ReiApi
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.UndoAction
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.data.downloadVersionTo
import dev.rei.android.data.libraryDetail
import dev.rei.android.data.setFileFavorite
import dev.rei.android.data.setFileTrashed
import dev.rei.android.di.AppContainer
import dev.rei.android.di.AppDispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the viewer body shows for the previewed version. */
sealed interface ViewerContent {
    data object Loading : ViewerContent
    class Words(val text: String, val truncated: Boolean, val markdown: Boolean) : ViewerContent
    class Picture(val bitmap: ImageBitmap) : ViewerContent
    class Document(val bytes: ByteArray, val name: String, val mediaType: String) : ViewerContent

    /** No preview for this kind (or it failed): [message] says why; Download is still offered. */
    class Unavailable(val message: String, val retry: Boolean = false) : ViewerContent
}

data class ViewerUiState(
    val fileId: String? = null,
    val detail: LibraryDetail? = null,
    /** The version being previewed; null until the detail arrives. Defaults to the pinned one, else the current one. */
    val shown: LibraryVersion? = null,
    val content: ViewerContent = ViewerContent.Loading,
    val compatibility: Boolean = false,
    /** The detail call failed, so there is nothing to show. */
    val error: String? = null,
    val working: Boolean = false,
) {
    val file get() = detail?.file
    val isLatest get() = shown == null || shown.versionId == detail?.file?.current?.versionId
}

sealed interface ViewerEvent {
    data object Close : ViewerEvent
}

private const val MaxBytes = 25L * 1024 * 1024
private const val MaxTextBytes = 1L * 1024 * 1024
private const val KeyPendingDownloadVersionId = "viewer_pending_download_version_id"
private const val KeyShownVersionId = "viewer_shown_version_id"
private const val KeyCompatibility = "viewer_compatibility"

/**
 * The open file: its detail, the previewed version's content, favorite, Trash and download.
 * Scoped to its NavBackStackEntry with [SavedStateHandle] so rotation keeps the downloaded preview and
 * process death while the system `CreateDocument` picker is open completes the download on return.
 */
class FileViewerViewModel(
    private val fileId: String,
    pinnedVersionId: String?,
    private val session: SessionRepository,
    private val workspace: WorkspaceRepository,
    private val savedStateHandle: SavedStateHandle,
    private val dispatchers: AppDispatchers = AppDispatchers(),
) : ViewModel() {
    private val initialCompatibility = savedStateHandle.get<Boolean>(KeyCompatibility) ?: false
    private val preferredVersionId = savedStateHandle.get<String>(KeyShownVersionId) ?: pinnedVersionId

    private val mutable = MutableStateFlow(ViewerUiState(fileId = fileId, compatibility = initialCompatibility))
    val state: StateFlow<ViewerUiState> = mutable.asStateFlow()

    private val eventsFlow = MutableSharedFlow<ViewerEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<ViewerEvent> = eventsFlow.asSharedFlow()

    private var load: Job? = null
    private val api: ReiApi? get() = session.currentApi

    init {
        loadDetail()
    }

    fun retry() {
        mutable.update { s -> s.copy(error = null) }
        loadDetail()
    }

    private fun loadDetail() {
        val api = api ?: return
        load?.cancel()
        load = viewModelScope.launch {
            try {
                val detail = api.libraryDetail(fileId)
                val versions = detail.versions.sortedByDescending { it.number }
                val targetVersionId = savedStateHandle.get<String>(KeyShownVersionId) ?: preferredVersionId
                val chosen = versions.firstOrNull { it.versionId == targetVersionId } ?: detail.file.current
                savedStateHandle[KeyShownVersionId] = chosen.versionId
                mutable.update { it.copy(detail = detail.copy(versions = versions), shown = chosen) }
                preview(api, chosen)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                mutable.update { it.copy(error = failure.localizedMessage ?: "Could not open this file.") }
            }
        }
    }

    fun showVersion(version: LibraryVersion) {
        val api = api ?: return
        if (version.versionId == mutable.value.shown?.versionId) return
        savedStateHandle[KeyShownVersionId] = version.versionId
        savedStateHandle[KeyCompatibility] = false
        mutable.update { it.copy(shown = version, compatibility = false, content = ViewerContent.Loading) }
        load?.cancel()
        load = viewModelScope.launch { preview(api, version) }
    }

    fun showLatest() { mutable.value.file?.current?.let(::showVersion) }

    fun toggleCompatibility() {
        val api = api ?: return
        val shown = mutable.value.shown ?: return
        val next = !mutable.value.compatibility
        savedStateHandle[KeyCompatibility] = next
        mutable.update { it.copy(compatibility = next, content = ViewerContent.Loading) }
        load?.cancel()
        load = viewModelScope.launch { preview(api, shown) }
    }

    fun reload() {
        val api = api ?: return
        val shown = mutable.value.shown ?: return
        mutable.update { it.copy(content = ViewerContent.Loading) }
        load?.cancel()
        load = viewModelScope.launch { preview(api, shown) }
    }

    private suspend fun preview(api: ReiApi, version: LibraryVersion) {
        val kind = previewKind(version.name, version.mediaType)
        val compat = mutable.value.compatibility && kind == PreviewKind.Office
        val content = try {
            when (kind) {
                PreviewKind.Audio, PreviewKind.Video, PreviewKind.Unsupported ->
                    ViewerContent.Unavailable("This file has no preview here. Download it to open it in another app.")
                PreviewKind.Text, PreviewKind.Markdown, PreviewKind.Html, PreviewKind.Csv -> {
                    val (bytes, cut) = fetch(api, version, MaxTextBytes, truncate = true, compat = false)
                    ViewerContent.Words(bytes.decodeToString(), truncated = cut, markdown = kind == PreviewKind.Markdown)
                }
                PreviewKind.Image -> {
                    val (bytes, _) = fetch(api, version, MaxBytes, truncate = false, compat = false)
                    val bitmap = withContext(dispatchers.default) { decodeImage(bytes) }
                    if (bitmap != null) ViewerContent.Picture(bitmap) else ViewerContent.Unavailable("This image can’t be previewed. Download it to open it in another app.")
                }
                PreviewKind.Pdf, PreviewKind.Office -> {
                    val (bytes, _) = fetch(api, version, MaxBytes, truncate = false, compat = compat)
                    if (compat) ViewerContent.Document(bytes, "preview.pdf", "application/pdf")
                    else ViewerContent.Document(bytes, version.name, version.mediaType)
                }
            }
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            ViewerContent.Unavailable(failure.localizedMessage ?: "Could not open the preview.", retry = true)
        }
        // A newer choice may have replaced this version while the bytes were arriving.
        mutable.update { if (it.shown?.versionId == version.versionId && it.compatibility == compat) it.copy(content = content) else it }
    }

    /** Reads one version (or its compatibility PDF) under a cap; [truncate] keeps the first [limit] bytes instead of failing. */
    private suspend fun fetch(api: ReiApi, version: LibraryVersion, limit: Long, truncate: Boolean, compat: Boolean): Pair<ByteArray, Boolean> {
        val request = if (compat) api.authenticatedRequest(listOf("api", "files", version.fileId, "versions", version.versionId, "compatibility")).build()
        else api.fileRequest(version.fileId, version.versionId)
        return with(ReiApi.Companion) {
            api.client.executeStreaming(request, dispatchers.io) { response ->
                check(response.isSuccessful) { "Preview failed (HTTP ${response.code})." }
                val body = checkNotNull(response.body) { "Preview failed." }
                val stream = body.source()
                if (truncate) {
                    val over = stream.request(limit + 1)
                    val bytes = stream.buffer.readByteArray(minOf(limit, stream.buffer.size))
                    bytes to over
                } else {
                    check(body.contentLength() <= limit && !stream.request(limit + 1)) { "This file is too large to preview." }
                    stream.readByteArray() to false
                }
            }
        }
    }

    fun toggleFavorite() {
        val api = api ?: return
        val file = mutable.value.file ?: return
        viewModelScope.launch {
            try {
                val updated = api.setFileFavorite(file.id, !file.favorite)
                mutable.update { it.copy(detail = it.detail?.copy(file = updated)) }
                workspace.notifyFilesChanged()
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // The star stays as it was; the next open shows the server's truth.
            }
        }
    }

    /** Moves to (or restores from) Trash; Undo runs in [WorkspaceRepository] so it outlives closing the viewer. */
    fun setTrashed(trashed: Boolean) {
        val api = api ?: return
        val file = mutable.value.file ?: return
        viewModelScope.launch {
            try {
                val updated = api.setFileTrashed(file.id, trashed)
                mutable.update { it.copy(detail = it.detail?.copy(file = updated)) }
                workspace.notifyFilesChanged()
                if (trashed) {
                    workspace.showNotice("Moved “${file.name}” to Trash", UndoAction.RestoreFile(file.id))
                    eventsFlow.tryEmit(ViewerEvent.Close)
                } else {
                    workspace.showNotice("Restored ${file.name}")
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                val fallback = if (trashed) "Could not move to Trash." else "Could not restore the file."
                workspace.showNotice(failure.localizedMessage ?: fallback)
            }
        }
    }

    /** Records the chosen version across process death before opening Android's CreateDocument picker. */
    fun prepareDownload(version: LibraryVersion): String {
        savedStateHandle[KeyPendingDownloadVersionId] = version.versionId
        return version.name
    }

    /** Completes a pending download once Android's CreateDocument picker returns [destination] (or clears if cancelled). */
    fun completeDownload(resolver: ContentResolver, destination: Uri?) {
        if (destination == null) {
            savedStateHandle.remove<String>(KeyPendingDownloadVersionId)
            return
        }
        completeDownload { resolver.openOutputStream(destination, "wt") }
    }

    internal fun completeDownload(openOutput: () -> java.io.OutputStream?) {
        val versionId = savedStateHandle.remove<String>(KeyPendingDownloadVersionId) ?: return
        val api = api ?: return
        mutable.update { it.copy(working = true) }
        viewModelScope.launch {
            try {
                val version = mutable.value.detail?.versions?.firstOrNull { it.versionId == versionId }
                    ?: api.libraryDetail(fileId).let { detail ->
                        detail.versions.firstOrNull { it.versionId == versionId } ?: detail.file.current
                    }
                withContext(dispatchers.io) {
                    val output = checkNotNull(openOutput()) { "Could not write to that location." }
                    output.use { api.downloadVersionTo(version.fileId, version.versionId, it, dispatchers.io) }
                }
                workspace.showNotice("Saved ${version.name}")
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                workspace.showNotice("Download failed: ${failure.localizedMessage ?: "Download failed."}")
            } finally {
                mutable.update { it.copy(working = false) }
            }
        }
    }

    private fun decodeImage(bytes: ByteArray): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > 4096 || bounds.outHeight / sample > 4096) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
    }

    companion object {
        fun factory(fileId: String, versionId: String?, container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                FileViewerViewModel(
                    fileId = fileId,
                    pinnedVersionId = versionId,
                    session = container.sessionRepository,
                    workspace = container.workspaceRepository,
                    savedStateHandle = createSavedStateHandle(),
                    dispatchers = container.dispatchers,
                )
            }
        }
    }
}
