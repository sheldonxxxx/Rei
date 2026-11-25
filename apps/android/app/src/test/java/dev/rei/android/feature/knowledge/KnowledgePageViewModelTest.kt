package dev.rei.android.feature.knowledge

import androidx.lifecycle.SavedStateHandle
import dev.rei.android.data.CredentialsGateway
import dev.rei.android.data.SavedConnection
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.UndoAction
import dev.rei.android.data.WorkspaceNotice
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.di.AppDispatchers
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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
class KnowledgePageViewModelTest {
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

    private fun pageJson(id: String, title: String, body: String, revision: Int = 1) =
        """{"page":{"id":"$id","title":"$title","description":"desc","metadata":{"tags":["ops"]},"revision":$revision,"locked":false,"pinned":false,"updatedAt":1},"body":"$body","ancestors":[],"children":[]}"""

    @Test
    fun unsavedEditsSurviveProcessDeathViaSavedStateHandleAndTrashEmitsUndoNotice() = runBlocking {
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                    "/api/health" -> MockResponse().setBody("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}""")
                    "/api/auth/state" -> MockResponse().setBody("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}""")
                    "/api/knowledge/pages/p1" -> MockResponse().setBody(pageJson("p1", "Server Title", "Server Body"))
                    "/api/knowledge/pages/p1/trash" -> MockResponse().setBody("""{"ok":true}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val url = server.url("/").toString().removeSuffix("/")
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val session = SessionRepository(scope, FakeCredentials(SavedConnection(url, "tok")), dispatchers, autoRestore = false)
            val workspace = WorkspaceRepository(scope, { session.currentApi })
            val savedState = SavedStateHandle()

            session.restore()
            withTimeout(5_000) { session.state.first { it.signedIn } }

            val vm = KnowledgePageViewModel("p1", session, workspace, savedState)
            val initial = withTimeout(5_000) { vm.state.first { it.page != null } }
            assertEquals("Server Title", initial.page?.title)

            vm.edit()
            vm.setTitle("Edited Draft Title")
            vm.setBody("Unsaved body")
            assertTrue(vm.state.value.dirty)

            // Simulate process death by recreating the ViewModel with the same SavedStateHandle.
            val recreated = KnowledgePageViewModel("p1", session, workspace, savedState)
            val loadedAfterDeath = withTimeout(5_000) { recreated.state.first { it.page != null } }
            assertTrue(loadedAfterDeath.editing)
            assertEquals("Edited Draft Title", loadedAfterDeath.draft.title)
            assertEquals("Unsaved body", loadedAfterDeath.draft.body)
            assertTrue(loadedAfterDeath.dirty)

            val notices = mutableListOf<WorkspaceNotice>()
            val events = mutableListOf<PageEvent>()
            val collectNotices = launch { workspace.notices.collect { notices += it } }
            val collectEvents = launch { recreated.events.collect { events += it } }

            recreated.trash()
            withTimeout(5_000) {
                while (events.isEmpty() || notices.isEmpty()) kotlinx.coroutines.delay(10)
            }
            assertEquals(listOf(PageEvent.Close), events)
            assertEquals(UndoAction.RestorePage("p1"), notices.single().undo)

            collectNotices.cancel()
            collectEvents.cancel()
            scope.cancel()
        }
    }
}
