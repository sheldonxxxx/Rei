package dev.rei.android.feature.knowledge

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.ReiViewModel
import dev.rei.android.data.KnowledgePageData
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.WorkspaceChanges
import dev.rei.android.data.addTag
import dev.rei.android.data.createKnowledgePage
import dev.rei.android.data.knowledgePage
import dev.rei.android.data.restoreKnowledgePage
import dev.rei.android.data.saveKnowledgePage
import dev.rei.android.data.setKnowledgePinned
import dev.rei.android.data.trashKnowledgePage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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

/** One page: read view first, an editor on demand, favorite, Trash and restore. One instance serves every open. */
class KnowledgePageViewModel(application: Application, private val source: ReiViewModel) : AndroidViewModel(application) {
    private val mutable = MutableStateFlow(PageUiState())
    val state: StateFlow<PageUiState> = mutable.asStateFlow()
    private var target: String? = null
    private var load: Job? = null
    private val api: ReiApi? get() = source.state.value.api

    /** Opens [target]: a page id, or [NewPageTarget] for an empty editor. Re-opening what is open does nothing. */
    fun open(target: String) {
        if (this.target == target && mutable.value.error == null) return
        this.target = target
        load?.cancel()
        if (target == NewPageTarget) {
            mutable.value = PageUiState(pageId = null, loading = false, editing = true)
        } else {
            mutable.value = PageUiState(pageId = target)
            fetch(target)
        }
    }

    /** The screen closed: the next open loads fresh. */
    fun forget() { load?.cancel(); target = null; mutable.value = PageUiState() }

    fun retry() { target?.takeIf { it != NewPageTarget }?.let { mutable.update { s -> s.copy(error = null, loading = true) }; fetch(it) } }

    private fun fetch(id: String, keepEditing: Boolean = false) {
        val api = api ?: return
        load?.cancel()
        load = viewModelScope.launch {
            try {
                val page = api.knowledgePage(id)
                mutable.update {
                    it.copy(
                        page = page, loading = false, error = null, saving = false, conflict = false, saveError = null,
                        editing = keepEditing && it.editing,
                        draft = PageDraft(page.title, page.description, page.body, page.tags),
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
        mutable.update { it.copy(editing = true, draft = PageDraft(page.title, page.description, page.body, page.tags), saveError = null, conflict = false, tagEntry = "", tagError = null) }
    }

    fun cancelEdit() {
        val page = mutable.value.page
        mutable.update {
            it.copy(editing = false, saveError = null, conflict = false, tagEntry = "", tagError = null,
                draft = page?.let { p -> PageDraft(p.title, p.description, p.body, p.tags) } ?: PageDraft())
        }
    }

    fun setTitle(value: String) = mutable.update { it.copy(draft = it.draft.copy(title = value)) }
    fun setDescription(value: String) = mutable.update { it.copy(draft = it.draft.copy(description = value)) }
    fun setBody(value: String) = mutable.update { it.copy(draft = it.draft.copy(body = value)) }
    fun setTagEntry(value: String) = mutable.update { it.copy(tagEntry = value, tagError = null) }

    fun commitTag() {
        val current = mutable.value
        addTag(current.draft.tags, current.tagEntry).fold(
            onSuccess = { tags -> mutable.update { it.copy(draft = it.draft.copy(tags = tags), tagEntry = "", tagError = null) } },
            onFailure = { failure -> mutable.update { it.copy(tagError = failure.message) } },
        )
    }

    fun removeTag(tag: String) = mutable.update { it.copy(draft = it.draft.copy(tags = it.draft.tags - tag)) }

    /** Saves the draft: creates the page when new, otherwise replaces the revision that was opened. */
    fun save(done: (KnowledgePageData) -> Unit = {}) {
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
                target = page.id
                mutable.value = PageUiState(pageId = page.id, page = page, loading = false)
                WorkspaceChanges.pagesChanged()
                done(page)
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
    fun reloadLatest() { mutable.value.pageId?.let { mutable.update { s -> s.copy(editing = false, conflict = false, saveError = null, loading = true) }; fetch(it) } }

    fun togglePinned() {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                val updated = api.setKnowledgePinned(page.id, !page.pinned)
                mutable.update { it.copy(page = it.page?.copy(pinned = updated.pinned, revision = updated.revision)) }
                WorkspaceChanges.pagesChanged()
            } catch (failure: CancellationException) {
                throw failure
            } catch (_: Exception) {
                // The star stays as it was.
            }
        }
    }

    fun trash(done: (title: String, id: String) -> Unit, failed: (String) -> Unit) {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                api.trashKnowledgePage(page.id)
                WorkspaceChanges.pagesChanged()
                done(page.title, page.id)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                failed(failure.localizedMessage ?: "Could not move the page to Trash.")
            }
        }
    }

    fun restore(done: (String) -> Unit, failed: (String) -> Unit) {
        val api = api ?: return
        val page = mutable.value.page ?: return
        viewModelScope.launch {
            try {
                val restored = api.restoreKnowledgePage(page.id)
                mutable.update { it.copy(page = restored, draft = PageDraft(restored.title, restored.description, restored.body, restored.tags)) }
                WorkspaceChanges.pagesChanged()
                done(restored.title)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                failed(failure.localizedMessage ?: "Could not restore the page.")
            }
        }
    }

    companion object {
        fun factory(source: ReiViewModel): ViewModelProvider.Factory = viewModelFactory {
            initializer { KnowledgePageViewModel(this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as Application, source) }
        }
    }
}
