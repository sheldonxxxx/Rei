package dev.rei.android.feature.knowledge

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.KnowledgePageData
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.UndoAction
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.data.addTag
import dev.rei.android.data.createKnowledgePage
import dev.rei.android.data.knowledgePage
import dev.rei.android.data.restoreKnowledgePage
import dev.rei.android.data.saveKnowledgePage
import dev.rei.android.data.setKnowledgePinned
import dev.rei.android.data.trashKnowledgePage
import dev.rei.android.di.AppContainer
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

/** The overlay target for "write a new page": no page id yet. */
const val NewPageTarget = "new"

/** The editor's working copy of the four things a page edit changes. */
data class PageDraft(
    val title: String = "",
    val description: String = "",
    val body: String = "",
    val tags: List<String> = emptyList(),
)

data class PageUiState(
    /** Null for a page being written; the id once it exists. */
    val pageId: String? = null,
    val page: KnowledgePageData? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val editing: Boolean = false,
    val draft: PageDraft = PageDraft(),
    val tagEntry: String = "",
    val tagError: String? = null,
    val saving: Boolean = false,
    val saveError: String? = null,
    /** The server holds a newer revision than the one being edited (HTTP 409). */
    val conflict: Boolean = false,
) {
    val isNew get() = pageId == null
    private val original get() = page?.let { PageDraft(it.title, it.description, it.body, it.tags) } ?: PageDraft()

    /** Anything differs from what was opened, so leaving would lose it. */
    val dirty get() = editing && draft != original

    /** Title is the one required field. */
    val canSave get() = draft.title.isNotBlank() && !saving && (isNew || dirty)
}

sealed interface PageEvent {
    data object Close : PageEvent
}

private const val KeyPageId = "knowledge_page_id"
private const val KeyEditing = "knowledge_page_editing"
private const val KeyDraftTitle = "knowledge_draft_title"
private const val KeyDraftDescription = "knowledge_draft_description"
private const val KeyDraftBody = "knowledge_draft_body"
private const val KeyDraftTags = "knowledge_draft_tags"
private const val KeyTagEntry = "knowledge_tag_entry"

/**
 * One Knowledge page: read view first, an editor on demand, favorite, Trash and restore.
 * Scoped to its own NavBackStackEntry with [SavedStateHandle] so rotation and process death preserve unsaved edits.
 */
class KnowledgePageViewModel(
    initialTarget: String,
    private val session: SessionRepository,
    private val workspace: WorkspaceRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val savedPageId: String? = if (savedStateHandle.contains(KeyPageId)) {
        savedStateHandle.get<String>(KeyPageId)
    } else {
        initialTarget.takeIf { it != NewPageTarget }
    }
    private val restoredEditing: Boolean = savedStateHandle.get<Boolean>(KeyEditing) ?: (savedPageId == null)
    private val restoredDraft = PageDraft(
        title = savedStateHandle.get<String>(KeyDraftTitle).orEmpty(),
        description = savedStateHandle.get<String>(KeyDraftDescription).orEmpty(),
        body = savedStateHandle.get<String>(KeyDraftBody).orEmpty(),
        tags = savedStateHandle.get<ArrayList<String>>(KeyDraftTags)?.toList().orEmpty(),
    )

    private val mutable = MutableStateFlow(
        PageUiState(
            pageId = savedPageId,
            loading = savedPageId != null,
            editing = restoredEditing,
            draft = restoredDraft,
            tagEntry = savedStateHandle.get<String>(KeyTagEntry).orEmpty(),
        ),
    )
    val state: StateFlow<PageUiState> = mutable.asStateFlow()

    private val eventsFlow = MutableSharedFlow<PageEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<PageEvent> = eventsFlow.asSharedFlow()

    private var load: Job? = null
    private val api: ReiApi? get() = session.currentApi

    init {
        if (savedPageId != null) {
            fetch(savedPageId, keepEditing = restoredEditing)
        }
    }

    fun retry() {
        val id = mutable.value.pageId ?: return
        mutable.update { s -> s.copy(error = null, loading = true) }
        fetch(id, keepEditing = mutable.value.editing)
    }

    private fun fetch(id: String, keepEditing: Boolean = false) {
        val api = api ?: return
        load?.cancel()
        load = viewModelScope.launch {
            try {
                val page = api.knowledgePage(id)
                mutable.update { current ->
                    val preserveDraft = keepEditing && current.editing
                    val nextDraft = if (preserveDraft) current.draft else PageDraft(page.title, page.description, page.body, page.tags)
                    current.copy(
                        page = page,
                        loading = false,
                        error = null,
                        saving = false,
                        conflict = false,
                        saveError = null,
                        editing = preserveDraft,
                        draft = nextDraft,
                    )
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                mutable.update { it.copy(loading = false, error = failure.localizedMessage ?: "Could not open this page.") }
            }
        }
    }

    fun edit() {
        val page = mutable.value.page ?: return
        if (page.locked) return
        val draft = PageDraft(page.title, page.description, page.body, page.tags)
        persistDraftState(editing = true, draft = draft, tagEntry = "")
        mutable.update { it.copy(editing = true, draft = draft, saveError = null, conflict = false, tagEntry = "", tagError = null) }
    }

    fun cancelEdit() {
        val page = mutable.value.page
        val draft = page?.let { PageDraft(it.title, it.description, it.body, it.tags) } ?: PageDraft()
        persistDraftState(editing = false, draft = draft, tagEntry = "")
        mutable.update {
            it.copy(editing = false, saveError = null, conflict = false, tagEntry = "", tagError = null, draft = draft)
        }
    }

    fun setTitle(value: String) {
        savedStateHandle[KeyDraftTitle] = value
        mutable.update { it.copy(draft = it.draft.copy(title = value)) }
    }

    fun setDescription(value: String) {
        savedStateHandle[KeyDraftDescription] = value
        mutable.update { it.copy(draft = it.draft.copy(description = value)) }
    }

    fun setBody(value: String) {
        savedStateHandle[KeyDraftBody] = value
        mutable.update { it.copy(draft = it.draft.copy(body = value)) }
    }

    fun setTagEntry(value: String) {
        savedStateHandle[KeyTagEntry] = value
        mutable.update { it.copy(tagEntry = value, tagError = null) }
    }

    fun commitTag() {
        val current = mutable.value
        addTag(current.draft.tags, current.tagEntry).fold(
            onSuccess = { tags ->
                savedStateHandle[KeyDraftTags] = ArrayList(tags)
                savedStateHandle[KeyTagEntry] = ""
                mutable.update { it.copy(draft = it.draft.copy(tags = tags), tagEntry = "", tagError = null) }
            },
            onFailure = { failure -> mutable.update { it.copy(tagError = failure.message) } },
        )
    }

    fun removeTag(tag: String) {
        val next = mutable.value.draft.tags - tag
        savedStateHandle[KeyDraftTags] = ArrayList(next)
        mutable.update { it.copy(draft = it.draft.copy(tags = next)) }
    }

    /** Saves the draft: creates the page when new, otherwise replaces the revision that was opened. */
    fun save() {
        val api = api ?: return
        val current = mutable.value
        if (!current.canSave) return
        // A tag typed but not yet added is added now rather than silently dropped.
        val tags = addTag(current.draft.tags, current.tagEntry).getOrDefault(current.draft.tags)
        val draft = current.draft.copy(title = current.draft.title.trim(), tags = tags)
        mutable.update { it.copy(saving = true, saveError = null, conflict = false) }
        viewModelScope.launch {
            try {
                val page = if (current.page == null) api.createKnowledgePage(draft.title, draft.description, draft.body, draft.tags)
                else api.saveKnowledgePage(current.page.id, current.page.revision, draft.title, draft.description, draft.body, draft.tags)
                savedStateHandle[KeyPageId] = page.id
                persistDraftState(editing = false, draft = PageDraft(page.title, page.description, page.body, page.tags), tagEntry = "")
                mutable.value = PageUiState(pageId = page.id, page = page, loading = false)
                workspace.notifyPagesChanged()
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: ReiApiException) {
                if (failure.status == 409) mutable.update { it.copy(saving = false, conflict = true, saveError = "This page changed while you were editing.") }
                else mutable.update { it.copy(saving = false, saveError = failure.localizedMessage ?: "Could not save the page.") }
            } catch (failure: Exception) {
                mutable.update { it.copy(saving = false, saveError = failure.localizedMessage ?: "Could not save the page.") }
            }
        }
    }

    /** After a conflict: drop the draft and load the newer revision. */
    fun reloadLatest() {
        val id = mutable.value.pageId ?: return
        persistDraftState(editing = false, draft = PageDraft(), tagEntry = "")
        mutable.update { s -> s.copy(editing = false, conflict = false, saveError = null, loading = true) }
        fetch(id, keepEditing = false)
    }

    fun togglePinned() {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                val updated = api.setKnowledgePinned(page.id, !page.pinned)
                mutable.update { it.copy(page = it.page?.copy(pinned = updated.pinned, revision = updated.revision)) }
                workspace.notifyPagesChanged()
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // The star stays as it was.
            }
        }
    }

    fun trash() {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                api.trashKnowledgePage(page.id)
                workspace.notifyPagesChanged()
                workspace.showNotice("Moved “${page.title}” to Trash", UndoAction.RestorePage(page.id))
                eventsFlow.tryEmit(PageEvent.Close)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                workspace.showNotice(failure.localizedMessage ?: "Could not move the page to Trash.")
            }
        }
    }

    fun restore() {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                val restored = api.restoreKnowledgePage(page.id)
                val draft = PageDraft(restored.title, restored.description, restored.body, restored.tags)
                persistDraftState(editing = mutable.value.editing, draft = draft, tagEntry = mutable.value.tagEntry)
                mutable.update { it.copy(page = restored, draft = draft) }
                workspace.notifyPagesChanged()
                workspace.showNotice("Restored “${restored.title}”")
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                workspace.showNotice(failure.localizedMessage ?: "Could not restore the page.")
            }
        }
    }

    private fun persistDraftState(editing: Boolean, draft: PageDraft, tagEntry: String) {
        savedStateHandle[KeyEditing] = editing
        savedStateHandle[KeyDraftTitle] = draft.title
        savedStateHandle[KeyDraftDescription] = draft.description
        savedStateHandle[KeyDraftBody] = draft.body
        savedStateHandle[KeyDraftTags] = ArrayList(draft.tags)
        savedStateHandle[KeyTagEntry] = tagEntry
    }

    companion object {
        fun factory(target: String, container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                KnowledgePageViewModel(
                    initialTarget = target,
                    session = container.sessionRepository,
                    workspace = container.workspaceRepository,
                    savedStateHandle = createSavedStateHandle(),
                )
            }
        }
    }
}
