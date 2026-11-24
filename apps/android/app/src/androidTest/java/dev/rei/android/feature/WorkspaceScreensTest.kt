package dev.rei.android.feature

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.rei.android.data.LibraryDetail
import dev.rei.android.data.LibraryFile
import dev.rei.android.data.LibraryVersion
import dev.rei.android.feature.knowledge.KnowledgeContent
import dev.rei.android.feature.knowledge.KnowledgeUiState
import dev.rei.android.feature.knowledge.PageDraft
import dev.rei.android.feature.knowledge.PageUiState
import dev.rei.android.feature.knowledge.KnowledgePageContent
import dev.rei.android.feature.library.LibraryContent
import dev.rei.android.feature.library.LibraryUiState
import dev.rei.android.feature.viewer.FileViewerContent
import dev.rei.android.feature.viewer.ViewerContent
import dev.rei.android.feature.viewer.ViewerUiState
import dev.rei.android.data.KnowledgePageData
import dev.rei.android.shell.Destination
import dev.rei.android.shell.DrawerMode
import dev.rei.android.shell.LocalShell
import dev.rei.android.shell.ShellController
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** The Library, viewer, Knowledge list and page view, found the way TalkBack finds them: by content description. */
class WorkspaceScreensTest {
    @get:Rule
    val compose = createComposeRule()

    private val version = LibraryVersion("f1", "v2", 2, "report.pdf", "application/pdf", 2048, 1_700_000_000_000, "Rei")
    private val file = LibraryFile("f1", "report.pdf", "upload", "Me", 1_700_000_000_000, 1_700_000_000_000, false, null, version)
    private val detail = LibraryDetail(file, listOf(version), null, emptyList())

    @Composable
    private fun Shell(content: @Composable () -> Unit) {
        ReiTheme {
            CompositionLocalProvider(LocalShell provides ShellController(Destination.Library, DrawerMode.Modal, {}, {}, {}), content = content)
        }
    }

    @Test
    fun theLibraryHasASearchFieldAFilterButtonAndAnUploadFab() {
        var uploads = 0
        var typed = ""
        compose.setContent {
            Shell {
                LibraryContent(
                    state = LibraryUiState(files = listOf(file), loaded = true),
                    api = null,
                    onText = { typed = it }, onTab = {}, onType = {}, onOrigin = {}, onSort = {}, onResetFilters = {},
                    onOpen = {}, onRefresh = {}, onLoadMore = {}, onRetry = {}, onUpload = { uploads++ }, onDismissError = {},
                )
            }
        }
        compose.onNodeWithContentDescription("Search library").performTextInput("inv")
        assertEquals("inv", typed)
        compose.onNodeWithContentDescription("Filters").assertIsEnabled()
        compose.onNodeWithContentDescription("Upload").performClick()
        assertEquals(1, uploads)
        compose.onNodeWithText("report.pdf").assertExists()
    }

    @Test
    fun anEmptyLibrarySaysSo() {
        compose.setContent {
            Shell {
                LibraryContent(
                    LibraryUiState(loaded = true), null, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
                )
            }
        }
        compose.onNodeWithText("No files here yet").assertExists()
    }

    @Test
    fun theViewerOffersInfoHistoryDownloadAndTrash() {
        val calls = mutableListOf<String>()
        compose.setContent {
            Shell {
                FileViewerContent(
                    state = ViewerUiState(fileId = "f1", detail = detail, shown = version, content = ViewerContent.Unavailable("No preview.")),
                    api = null,
                    onBack = { calls += "back" },
                    onInfo = { calls += "info" },
                    onHistory = { calls += "history" },
                    onDownload = { calls += "download" },
                    onTrash = { calls += "trash" },
                    onRestore = { calls += "restore" },
                    onRetry = {}, onCompatibility = {}, onShowLatest = {},
                )
            }
        }
        listOf("Info", "History", "Download", "Move to Trash").forEach { compose.onNodeWithContentDescription(it).assertIsEnabled().performClick() }
        assertEquals(listOf("info", "history", "download", "trash"), calls)
    }

    @Test
    fun aTrashedFileOffersRestoreInsteadOfTrash() {
        var restored = 0
        compose.setContent {
            Shell {
                FileViewerContent(
                    state = ViewerUiState(fileId = "f1", detail = detail.copy(file = file.copy(trashedAt = 1L)), shown = version, content = ViewerContent.Unavailable("x")),
                    api = null, onBack = {}, onInfo = {}, onHistory = {}, onDownload = {}, onTrash = {}, onRestore = { restored++ },
                    onRetry = {}, onCompatibility = {}, onShowLatest = {},
                )
            }
        }
        compose.onNodeWithContentDescription("Move to Trash").assertDoesNotExist()
        compose.onNodeWithContentDescription("Restore").performClick()
        assertEquals(1, restored)
    }

    @Test
    fun theViewerActionsWaitForTheFileToLoad() {
        compose.setContent {
            Shell {
                FileViewerContent(ViewerUiState(fileId = "f1"), null, {}, {}, {}, {}, {}, {}, {}, {}, {})
            }
        }
        compose.onNodeWithContentDescription("Info").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Download").assertIsNotEnabled()
    }

    @Test
    fun knowledgeHasSearchAndANewPageFab() {
        var created = 0
        compose.setContent {
            Shell {
                KnowledgeContent(
                    state = KnowledgeUiState(loaded = true),
                    onText = {}, onTab = {}, onToggleTag = {}, onResetFilters = {}, onToggleExpanded = {}, onEnsureTags = {},
                    onOpen = {}, onRestore = {}, onRefresh = {}, onRetry = {}, onNewPage = { created++ }, onDismissError = {},
                )
            }
        }
        compose.onNodeWithContentDescription("Search knowledge").assertExists()
        compose.onNodeWithContentDescription("New page").performClick()
        assertEquals(1, created)
        compose.onNodeWithText("No pages yet").assertExists()
    }

    private val page = KnowledgePageData(
        id = "p1", parentId = null, title = "Trip plan", description = "Where to go", tags = listOf("travel"), revision = 1, locked = false,
        pinned = false, trashedAt = null, updatedAt = 1_700_000_000_000, updatedBy = "Me", body = "Pack light.", ancestors = emptyList(), children = emptyList(),
    )

    private fun pageContent(state: PageUiState, onEdit: () -> Unit = {}, onSave: () -> Unit = {}) = compose.setContent {
        Shell {
            KnowledgePageContent(
                state, null, menuOpen = false, onMenu = {}, onBack = {}, onEdit = onEdit, onSave = onSave, onTitle = {}, onDescription = {},
                onBody = {}, onTagEntry = {}, onCommitTag = {}, onRemoveTag = {}, onReload = {}, onRetry = {}, onOpenPage = {},
                onFavorite = {}, onTrash = {}, onRestore = {},
            )
        }
    }

    @Test
    fun aPageReadsFirstAndEditsOnDemand() {
        var edits = 0
        pageContent(PageUiState(pageId = "p1", page = page, loading = false), onEdit = { edits++ })
        compose.onNodeWithText("Trip plan").assertExists()
        compose.onNodeWithContentDescription("Edit").performClick()
        assertEquals(1, edits)
        compose.onNodeWithContentDescription("More options").assertExists()
    }

    @Test
    fun theEditorHasOnePrimarySaveButtonThatNeedsAChange() {
        pageContent(PageUiState(pageId = "p1", page = page, loading = false, editing = true, draft = PageDraft("Trip plan", "Where to go", "Pack light.", listOf("travel"))))
        compose.onNodeWithText("Save").assertIsNotEnabled()
    }

    @Test
    fun savingIsEnabledOnceTheDraftChanges() {
        var saved = 0
        pageContent(
            PageUiState(pageId = "p1", page = page, loading = false, editing = true, draft = PageDraft("Trip plan 2", "Where to go", "Pack light.", listOf("travel"))),
            onSave = { saved++ },
        )
        compose.onNodeWithText("Save").assertIsEnabled().performClick()
        assertEquals(1, saved)
    }
}
