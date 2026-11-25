package dev.rei.android.feature.knowledge

import dev.rei.android.data.KnowledgeNode
import dev.rei.android.data.KnowledgePageData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun node(id: String, parent: String? = null, pinned: Boolean = false, children: Int = 0) = KnowledgeNode(
    id = id, parentId = parent, title = id, description = "", updatedAt = 0, updatedBy = "", locked = false,
    pinned = pinned, inbox = false, childCount = children, trashedAt = null,
)

private fun page(title: String = "T", body: String = "B") = KnowledgePageData(
    id = "p", parentId = null, title = title, description = "D", tags = listOf("a"), revision = 3, locked = false, pinned = false,
    trashedAt = null, updatedAt = 0, updatedBy = "", body = body, ancestors = emptyList(), children = emptyList(),
)

class KnowledgeTest {
    private val tree = listOf(node("a", children = 2), node("a1", "a", children = 1), node("a1x", "a1"), node("a2", "a", pinned = true), node("b"))

    @Test
    fun closedParentsHideTheirChildren() {
        val rows = knowledgeRows(KnowledgeTab.All, tree, emptyList(), emptySet())
        assertEquals(listOf("a", "b"), rows.map { it.node.id })
    }

    @Test
    fun openParentsShowChildrenDepthFirstWithDepth() {
        val rows = knowledgeRows(KnowledgeTab.All, tree, emptyList(), setOf("a", "a1"))
        assertEquals(listOf("a", "a1", "a1x", "a2", "b"), rows.map { it.node.id })
        assertEquals(listOf(0, 1, 2, 1, 0), rows.map { it.depth })
        assertTrue(rows.first().expanded)
    }

    @Test
    fun aNodeWhoseParentIsMissingCountsAsARoot() {
        val rows = knowledgeRows(KnowledgeTab.All, listOf(node("orphan", "gone")), emptyList(), emptySet())
        assertEquals(listOf("orphan"), rows.map { it.node.id })
    }

    @Test
    fun favoritesAndTrashAreFlat() {
        assertEquals(listOf("a2"), knowledgeRows(KnowledgeTab.Favorites, tree, emptyList(), setOf("a")).map { it.node.id })
        assertEquals(listOf("t"), knowledgeRows(KnowledgeTab.Trash, tree, listOf(node("t")), emptySet()).map { it.node.id })
    }

    @Test
    fun searchingMeansWordsOrTags() {
        assertFalse(KnowledgeUiState().searching)
        assertTrue(KnowledgeUiState(searchText = "x").searching)
        assertTrue(KnowledgeUiState(selectedTags = listOf("t")).searching)
    }

    @Test
    fun theEditorIsDirtyOnlyWhenSomethingChanged() {
        val opened = PageUiState(pageId = "p", page = page(), loading = false, editing = true, draft = PageDraft("T", "D", "B", listOf("a")))
        assertFalse(opened.dirty)
        assertFalse(opened.canSave)
        val edited = opened.copy(draft = opened.draft.copy(body = "B2"))
        assertTrue(edited.dirty)
        assertTrue(edited.canSave)
        assertFalse(edited.copy(draft = edited.draft.copy(title = " ")).canSave)
        assertFalse(edited.copy(saving = true).canSave)
    }

    @Test
    fun aNewPageSavesOnceItHasATitle() {
        val fresh = PageUiState(pageId = null, loading = false, editing = true)
        assertTrue(fresh.isNew)
        assertFalse(fresh.canSave)
        assertTrue(fresh.copy(draft = PageDraft(title = "Hello")).canSave)
    }

    @Test
    fun stateRowsCacheMatchesKnowledgeRowsHelper() {
        val state = KnowledgeUiState(tab = KnowledgeTab.All, tree = tree, expanded = setOf("a"))
        assertEquals(listOf("a", "a1", "a2", "b"), state.rows.map { it.node.id })
        assertTrue(state.rows === state.rows)
    }
}
