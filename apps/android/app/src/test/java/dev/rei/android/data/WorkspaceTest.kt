package dev.rei.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceTest {
    @Test
    fun theLibraryQueryAsksForOnlyWhatIsSet() {
        assertEquals(mapOf("sort" to "recent"), LibraryQuery().toParameters())
        val query = LibraryQuery(text = "  invoice ", type = "pdf", origin = "upload", sort = LibrarySort.Name, tab = LibraryTab.Favorites)
        assertEquals(
            mapOf("q" to "invoice", "type" to "pdf", "origin" to "upload", "sort" to "name", "favorite" to "1", "cursor" to "next"),
            query.toParameters("next"),
        )
        assertEquals("1", LibraryQuery(tab = LibraryTab.Trash).toParameters()["trash"])
    }

    @Test
    fun filteredIgnoresTheTabButSeesSearchAndFacets() {
        assertFalse(LibraryQuery(tab = LibraryTab.Trash).filtered)
        assertTrue(LibraryQuery(text = "a").filtered)
        assertTrue(LibraryQuery(type = "image").filtered)
        assertTrue(LibraryQuery(origin = "agent").filtered)
    }

    @Test
    fun tagsNormalizeTheWayTheServerDoes() {
        assertEquals(listOf("work", "plans"), addTag(listOf("work"), "  plans ").getOrThrow())
        assertEquals(listOf("work"), addTag(listOf("work"), "WORK").getOrThrow())
        assertEquals(listOf("a b"), addTag(emptyList(), "a    b").getOrThrow())
        assertEquals(listOf("x"), addTag(listOf("x"), "   ").getOrThrow())
    }

    @Test
    fun tagsRefuseWhatTheServerWouldRefuse() {
        assertTrue(addTag(emptyList(), "x".repeat(41)).isFailure)
        assertTrue(addTag(emptyList(), "bad\u0007tag").isFailure)
        assertTrue(addTag(List(20) { "t$it" }, "one more").isFailure)
        assertTrue(addTag(List(20) { "t$it" }, "T3").isSuccess)
    }
}
