package dev.rei.android.feature.library

import androidx.lifecycle.SavedStateHandle
import dev.rei.android.data.CredentialsGateway
import dev.rei.android.data.LibrarySort
import dev.rei.android.data.LibraryTab
import dev.rei.android.data.SavedConnection
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.di.AppDispatchers
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LibraryViewModelTest {
    private val mainThread = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val dispatchers = AppDispatchers(io = Dispatchers.IO, default = Dispatchers.Default, main = mainThread)

    @Before
    fun setUp() {
        Dispatchers.setMain(mainThread)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        mainThread.close()
    }

    private class FakeCredentials(@Volatile var saved: SavedConnection?) : CredentialsGateway {
        override fun load() = saved
        override fun save(serverUrl: String, token: String?) { saved = SavedConnection(serverUrl, token) }
        override fun clear() { saved = null }
    }

    @Test
    fun loadsFilesPersistsFiltersInSavedStateAndRefreshesOnWorkspaceSignal() = runBlocking {
        val fetchCount = AtomicInteger(0)
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl?.encodedPath
                    return when (path) {
                        "/api/health" -> MockResponse().setBody("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}""")
                        "/api/auth/state" -> MockResponse().setBody("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}""")
                        "/api/files" -> {
                            fetchCount.incrementAndGet()
                            MockResponse().setBody(
                                """{"files":[{"id":"f1","name":"notes.md","origin":"upload","createdAt":1,"updatedAt":2,"favorite":false,
                                    "current":{"fileId":"f1","versionId":"v1","number":1,"name":"notes.md","mediaType":"text/markdown","size":42,"createdAt":1}}],"nextCursor":null}""",
                            )
                        }
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            val url = server.url("/").toString().removeSuffix("/")
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val session = SessionRepository(scope, FakeCredentials(SavedConnection(url, "tok")), dispatchers, autoRestore = false)
            val workspace = WorkspaceRepository(scope, { session.currentApi })
            val savedState = SavedStateHandle()

            session.restore()
            withTimeout(5_000) { session.state.first { it.signedIn } }

            val vm = LibraryViewModel(session, workspace, savedState, dispatchers)
            val loaded = withTimeout(5_000) { vm.state.first { it.loaded } }
            assertEquals(1, loaded.files.size)
            assertEquals("notes.md", loaded.files.single().name)
            val initialFetches = fetchCount.get()

            vm.setTab(LibraryTab.Favorites)
            vm.setSort(LibrarySort.Name)
            withTimeout(5_000) { vm.state.first { it.query.tab == LibraryTab.Favorites && it.query.sort == LibrarySort.Name && !it.refreshing } }
            withTimeout(5_000) {
                while (fetchCount.get() <= initialFetches) kotlinx.coroutines.delay(10)
            }

            // Recreating the ViewModel with the same SavedStateHandle preserves tab and sort.
            val restoredVm = LibraryViewModel(session, workspace, savedState, dispatchers)
            assertEquals(LibraryTab.Favorites, restoredVm.state.value.query.tab)
            assertEquals(LibrarySort.Name, restoredVm.state.value.query.sort)

            val beforeSignal = fetchCount.get()
            workspace.notifyFilesChanged()
            withTimeout(5_000) {
                while (fetchCount.get() <= beforeSignal) kotlinx.coroutines.delay(10)
            }
            assertTrue(fetchCount.get() > beforeSignal)
            scope.cancel()
        }
    }
}
