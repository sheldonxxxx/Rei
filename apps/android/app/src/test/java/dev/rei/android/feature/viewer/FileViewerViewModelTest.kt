package dev.rei.android.feature.viewer

import androidx.lifecycle.SavedStateHandle
import dev.rei.android.data.CredentialsGateway
import dev.rei.android.data.SavedConnection
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.UndoAction
import dev.rei.android.data.WorkspaceNotice
import dev.rei.android.data.WorkspaceRepository
import dev.rei.android.di.AppDispatchers
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
class FileViewerViewModelTest {
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

    private fun detailJson(trashedAt: Long? = null): String {
        val trashedField = trashedAt?.let { ""","trashedAt":"$it"""" } ?: ""
        return """{"file":{"id":"f1","name":"readme.txt","origin":"upload","createdAt":1,"updatedAt":2,"favorite":false$trashedField,
            "current":{"fileId":"f1","versionId":"v1","number":1,"name":"readme.txt","mediaType":"text/plain","size":11,"createdAt":1}},
            "versions":[{"fileId":"f1","versionId":"v1","number":1,"name":"readme.txt","mediaType":"text/plain","size":11,"createdAt":1}],
            "chats":[]}"""
    }

    @Test
    fun loadsTextPreviewCompletesDownloadAfterProcessDeathAndEmitsTrashUndo() = runBlocking {
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                    "/api/health" -> MockResponse().setBody("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}""")
                    "/api/auth/state" -> MockResponse().setBody("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}""")
                    "/api/files/f1" -> when (request.method) {
                        "GET" -> MockResponse().setBody(detailJson())
                        "PATCH" -> MockResponse().setBody(detailJson(trashedAt = 1234L))
                        else -> MockResponse().setResponseCode(404)
                    }
                    "/api/files/f1/versions/v1/content" -> MockResponse().setBody("hello world")
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

            val vm = FileViewerViewModel("f1", null, session, workspace, savedState, dispatchers)
            val previewState = withTimeout(5_000) { vm.state.first { it.content is ViewerContent.Words } }
            assertEquals("hello world", (previewState.content as ViewerContent.Words).text)

            val version = previewState.shown!!
            assertEquals("readme.txt", vm.prepareDownload(version))

            // Simulate process death before CreateDocument picker returns.
            val recreated = FileViewerViewModel("f1", null, session, workspace, savedState, dispatchers)
            val notices = mutableListOf<WorkspaceNotice>()
            val events = mutableListOf<ViewerEvent>()
            val collectNotices = launch { workspace.notices.collect { notices += it } }
            val collectEvents = launch { recreated.events.collect { events += it } }

            val out = ByteArrayOutputStream()
            recreated.completeDownload { out }
            withTimeout(5_000) {
                while (notices.isEmpty()) delay(10)
            }
            assertEquals("hello world", out.toString("UTF-8"))
            assertEquals(dev.rei.android.ui.UiText.Resource(dev.rei.android.R.string.viewer_notice_saved, "readme.txt"), notices.last().message)

            recreated.setTrashed(true)
            withTimeout(5_000) {
                while (events.isEmpty() || notices.size < 2) delay(10)
            }
            assertEquals(listOf(ViewerEvent.Close), events)
            assertEquals(UndoAction.RestoreFile("f1"), notices.last().undo)

            collectNotices.cancel()
            collectEvents.cancel()
            scope.cancel()
        }
    }
}
