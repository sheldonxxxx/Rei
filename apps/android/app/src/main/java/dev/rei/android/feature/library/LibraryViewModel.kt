package dev.rei.android.feature.library

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.ReiViewModel
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.LibraryQuery
import dev.rei.android.data.LibrarySort
import dev.rei.android.data.LibraryTab
import dev.rei.android.data.ReiApi
import dev.rei.android.data.WorkspaceChanges
import dev.rei.android.data.listLibrary
import dev.rei.android.data.uploadBody
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** An upload in flight: [index] of [total], the file's [name]. */
data class UploadProgress(val index: Int, val total: Int, val name: String)

data class LibraryUiState(
    /** What the field shows right now; [query] follows it after a short pause. */
    val searchText: String = "",
    val query: LibraryQuery = LibraryQuery(),
    val files: List<LibraryFile> = emptyList(),
    /** The first page of the current query has arrived (or failed). */
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val nextCursor: String? = null,
    val loadFailed: Boolean = false,
    val error: String? = null,
    val upload: UploadProgress? = null,
    val uploadError: String? = null,
)

/** Paging, search, filters, upload and refresh for the Library list. The opened file is the viewer's business. */
@OptIn(FlowPreview::class)
class LibraryViewModel(application: Application, private val source: ReiViewModel) : AndroidViewModel(application) {
    private val mutable = MutableStateFlow(LibraryUiState())
    val state: StateFlow<LibraryUiState> = mutable.asStateFlow()
    private val text = MutableStateFlow("")
    private val facets = MutableStateFlow(LibraryQuery())
    private var load: Job? = null
    private var more: Job? = null
    private var api: ReiApi? = null

    init {
        viewModelScope.launch {
            combine(source.state.map { it.api }.distinctUntilChanged(), text.debounce(250).distinctUntilChanged(), facets) { api, text, facets ->
                api to facets.copy(text = text)
            }.collectLatest { (api, query) ->
                this@LibraryViewModel.api = api
                mutable.update { it.copy(query = query) }
                if (api != null) reload(api, query, refreshing = false)
            }
        }
        viewModelScope.launch { WorkspaceChanges.files.collect { refresh(quiet = true) } }
    }

    fun setText(value: String) {
        mutable.update { it.copy(searchText = value) }
        text.value = value
    }

    fun setTab(tab: LibraryTab) = facets.update { it.copy(tab = tab) }
    fun setType(type: String) = facets.update { it.copy(type = type) }
    fun setOrigin(origin: String) = facets.update { it.copy(origin = origin) }
    fun setSort(sort: LibrarySort) = facets.update { it.copy(sort = sort) }

    fun clearFilters() {
        facets.update { it.copy(type = "", origin = "", tab = LibraryTab.All) }
        setText("")
    }

    /** Pull to refresh, or a quiet reload after a change elsewhere (the rows stay where they are). */
    fun refresh(quiet: Boolean = false) {
        val api = api ?: return
        load?.cancel()
        load = viewModelScope.launch { reload(api, mutable.value.query, refreshing = !quiet) }
    }

    fun retry() = refresh()

    private suspend fun reload(api: ReiApi, query: LibraryQuery, refreshing: Boolean) {
        more?.cancel()
        mutable.update { it.copy(refreshing = refreshing, loadingMore = false, error = null, loadFailed = false) }
        try {
            val page = api.listLibrary(query)
            mutable.update { it.copy(files = page.files, nextCursor = page.nextCursor, loaded = true, refreshing = false) }
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            mutable.update {
                it.copy(loaded = true, refreshing = false, loadFailed = it.files.isEmpty(), error = failure.localizedMessage ?: "Could not load files.")
            }
        }
    }

    fun loadMore() {
        val api = api ?: return
        val current = mutable.value
        val cursor = current.nextCursor ?: return
        if (current.loadingMore || current.refreshing || more?.isActive == true) return
        mutable.update { it.copy(loadingMore = true) }
        more = viewModelScope.launch {
            try {
                val page = api.listLibrary(current.query, cursor)
                mutable.update { state ->
                    state.copy(
                        files = (state.files + page.files).distinctBy { it.id },
                        nextCursor = page.nextCursor,
                        loadingMore = false,
                    )
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                mutable.update { it.copy(loadingMore = false, error = failure.localizedMessage ?: "Could not load more files.") }
            }
        }
    }

    fun dismissError() = mutable.update { it.copy(error = null, uploadError = null) }

    /** Uploads the picked documents one after another; each failure is reported and the rest still go. */
    fun upload(resolver: ContentResolver, uris: List<Uri>) {
        val api = api ?: return
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val problems = mutableListOf<String>()
            uris.forEachIndexed { index, uri ->
                try {
                    val (name, body) = withContext(Dispatchers.IO) { resolver.uploadBody(uri) }
                    mutable.update { it.copy(upload = UploadProgress(index + 1, uris.size, name), uploadError = null) }
                    try {
                        api.uploadFile(listOf("api", "files"), name, body)
                    } catch (failure: CancellationException) {
                        throw failure
                    } catch (failure: Exception) {
                        problems += "$name: ${failure.localizedMessage ?: "could not be uploaded"}"
                    }
                } catch (failure: CancellationException) {
                    throw failure
                } catch (failure: Exception) {
                    problems += failure.localizedMessage ?: "A file could not be read."
                }
            }
            mutable.update { it.copy(upload = null, uploadError = problems.takeIf { p -> p.isNotEmpty() }?.joinToString("\n")) }
            refresh(quiet = true)
        }
    }

    companion object {
        fun factory(source: ReiViewModel): ViewModelProvider.Factory = viewModelFactory {
            initializer { LibraryViewModel(this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as Application, source) }
        }
    }
}
