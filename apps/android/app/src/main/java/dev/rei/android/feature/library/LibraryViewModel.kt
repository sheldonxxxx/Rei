package dev.rei.android.feature.library

import android.content.ContentResolver
import android.net.Uri
import androidx.compose.runtime.Immutable
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.R
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.LibraryQuery
import dev.rei.android.data.LibrarySort
import dev.rei.android.data.LibraryTab
import dev.rei.android.data.ReiApi
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.data.listLibrary
import dev.rei.android.data.uploadBody
import dev.rei.android.di.AppContainer
import dev.rei.android.di.AppDispatchers
import dev.rei.android.ui.UiText
import dev.rei.android.ui.asUiText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** An upload in flight: [index] of [total], the file's [name]. */
data class UploadProgress(val index: Int, val total: Int, val name: String)

@Immutable
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
    val error: UiText? = null,
    val upload: UploadProgress? = null,
    val uploadError: List<UiText> = emptyList(),
)

private const val KeyText = "library_text"
private const val KeyTab = "library_tab"
private const val KeyType = "library_type"
private const val KeyOrigin = "library_origin"
private const val KeySort = "library_sort"

/** Paging, search, filters, upload and refresh for the Library list. The opened file is the viewer's business. */
@OptIn(FlowPreview::class)
class LibraryViewModel(
    private val session: SessionRepository,
    private val workspace: WorkspaceRepository,
    private val savedStateHandle: SavedStateHandle,
    private val dispatchers: AppDispatchers = AppDispatchers(),
) : ViewModel() {
    private val initialText = savedStateHandle.get<String>(KeyText).orEmpty()
    private val initialFacets = LibraryQuery(
        text = initialText,
        type = savedStateHandle.get<String>(KeyType).orEmpty(),
        origin = savedStateHandle.get<String>(KeyOrigin).orEmpty(),
        sort = savedStateHandle.get<String>(KeySort)?.let { name -> LibrarySort.entries.firstOrNull { it.name == name } } ?: LibrarySort.Recent,
        tab = savedStateHandle.get<String>(KeyTab)?.let { name -> LibraryTab.entries.firstOrNull { it.name == name } } ?: LibraryTab.All,
    )

    private val mutable = MutableStateFlow(LibraryUiState(searchText = initialText, query = initialFacets))
    val state: StateFlow<LibraryUiState> = mutable.asStateFlow()
    private val text = MutableStateFlow(initialText)
    private val facets = MutableStateFlow(initialFacets)
    private var load: Job? = null
    private var more: Job? = null
    private var api: ReiApi? = null

    init {
        viewModelScope.launch {
            combine(session.api, text.debounce(250).distinctUntilChanged(), facets) { api, text, facets ->
                api to facets.copy(text = text)
            }.collectLatest { (api, query) ->
                this@LibraryViewModel.api = api
                mutable.update { it.copy(query = query) }
                if (api != null) reload(api, query, refreshing = false)
            }
        }
        viewModelScope.launch { workspace.filesChanged.collect { refresh(quiet = true) } }
    }

    fun setText(value: String) {
        savedStateHandle[KeyText] = value
        mutable.update { it.copy(searchText = value) }
        text.value = value
    }

    fun setTab(tab: LibraryTab) {
        savedStateHandle[KeyTab] = tab.name
        facets.update { it.copy(tab = tab) }
    }

    fun setType(type: String) {
        savedStateHandle[KeyType] = type
        facets.update { it.copy(type = type) }
    }

    fun setOrigin(origin: String) {
        savedStateHandle[KeyOrigin] = origin
        facets.update { it.copy(origin = origin) }
    }

    fun setSort(sort: LibrarySort) {
        savedStateHandle[KeySort] = sort.name
        facets.update { it.copy(sort = sort) }
    }

    fun clearFilters() {
        savedStateHandle[KeyType] = ""
        savedStateHandle[KeyOrigin] = ""
        savedStateHandle[KeyTab] = LibraryTab.All.name
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
                it.copy(
                    loaded = true,
                    refreshing = false,
                    loadFailed = it.files.isEmpty(),
                    error = failure.asUiText(UiText.Resource(R.string.library_err_load)),
                )
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
                mutable.update { it.copy(loadingMore = false, error = failure.asUiText(UiText.Resource(R.string.library_err_load_more))) }
            }
        }
    }

    fun dismissError() = mutable.update { it.copy(error = null, uploadError = emptyList()) }

    /** Uploads the picked documents one after another; each failure is reported and the rest still go. */
    fun upload(resolver: ContentResolver, uris: List<Uri>, defaultFilename: String = "attachment") {
        val api = api ?: return
        if (uris.isEmpty()) return
        viewModelScope.launch {
            val problems = mutableListOf<UiText>()
            uris.forEachIndexed { index, uri ->
                try {
                    val (name, body) = withContext(dispatchers.io) { resolver.uploadBody(uri, defaultFilename) }
                    mutable.update { it.copy(upload = UploadProgress(index + 1, uris.size, name), uploadError = emptyList()) }
                    try {
                        api.uploadFile(listOf("api", "files"), name, body)
                    } catch (failure: CancellationException) {
                        throw failure
                    } catch (failure: Exception) {
                        problems += UiText.Resource(
                            R.string.library_err_upload_item,
                            name,
                            failure.asUiText(UiText.Resource(R.string.library_err_upload_failed)),
                        )
                    }
                } catch (failure: CancellationException) {
                    throw failure
                } catch (failure: Exception) {
                    problems += failure.asUiText(UiText.Resource(R.string.library_err_read_file))
                }
            }
            mutable.update { it.copy(upload = null, uploadError = problems) }
            refresh(quiet = true)
        }
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                LibraryViewModel(
                    session = container.sessionRepository,
                    workspace = container.workspaceRepository,
                    savedStateHandle = createSavedStateHandle(),
                    dispatchers = container.dispatchers,
                )
            }
        }
    }
}
