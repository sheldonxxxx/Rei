package dev.rei.android.data

import dev.rei.android.di.AppDispatchers
import java.util.concurrent.Executors
import dev.rei.android.R
import dev.rei.android.ui.UiText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionRepositoryTest {
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

    private class FakeCredentials(initial: SavedConnection? = null) : CredentialsGateway {
        @Volatile var current: SavedConnection? = initial
        override fun load(): SavedConnection? = current
        override fun save(serverUrl: String, token: String?) {
            current = SavedConnection(serverUrl, token)
        }
        override fun clear() {
            current = null
        }
    }

    private fun json(body: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    @Test
    fun restoreWithSavedTokenEntersSignedInState() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(json("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}"""))
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials(SavedConnection(url, "saved-token"))
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val repo = SessionRepository(scope, creds, dispatchers, autoRestore = false)

            repo.restore()
            val state = withTimeout(5_000) { repo.state.first { !it.restoring } }

            assertTrue(state.signedIn)
            assertNotNull(repo.currentApi)
            assertEquals(url, state.serverUrl)
            scope.cancel()
        }
    }

    @Test
    fun connectAndSignInPersistsTokenAndReports401Reset() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(json("""{"setupRequired":false,"signedIn":false,"totpEnabled":false}"""))
            server.enqueue(json("""{"ok":true,"token":"fresh-token","deviceId":"d1"}"""))
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials()
            var signedOutCalls = 0
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val repo = SessionRepository(
                scope = scope,
                credentials = creds,
                dispatchers = dispatchers,
                onSignedOut = { signedOutCalls++ },
                autoRestore = false,
            )

            repo.connect(url)
            val connected = withTimeout(5_000) { repo.state.first { it.auth != null && !it.working } }
            assertFalse(connected.signedIn)

            repo.signIn("secret-password", "", "Pixel")
            val signedIn = withTimeout(5_000) { repo.state.first { it.signedIn } }
            assertTrue(signedIn.signedIn)
            assertEquals("fresh-token", creds.current?.token)

            repo.reportFailure(ReiApiException(401, "unauthorized", "Session expired"))
            val signedOut = withTimeout(5_000) { repo.state.first { !it.signedIn && it.error != null } }
            assertNull(repo.currentApi)
            assertNull(creds.current)
            assertEquals(1, signedOutCalls)
            assertEquals(UiText.Resource(R.string.session_err_signed_out), signedOut.error)
            scope.cancel()
        }
    }

    @Test
    fun outdated426TriggersCallbackAndUpgradeRequired() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(json("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}"""))
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials(SavedConnection(url, "tok"))
            var outdatedCalls = 0
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val repo = SessionRepository(
                scope = scope,
                credentials = creds,
                dispatchers = dispatchers,
                onOutdated = { outdatedCalls++ },
                autoRestore = false,
            )

            repo.restore()
            withTimeout(5_000) { repo.state.first { it.signedIn } }

            repo.reportFailure(ReiApiException(426, "client_outdated", "Upgrade required"))
            val upgraded = withTimeout(5_000) { repo.state.first { it.upgradeRequired } }
            assertEquals(1, outdatedCalls)
            assertFalse(upgraded.signedIn)
            scope.cancel()
        }
    }

    @Test
    fun backgroundCancelsGlobalSseJobAndForegroundRestartsIt() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(json("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}"""))
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(": ping\n\n"))
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials(SavedConnection(url, "tok"))
            val scopeJob = SupervisorJob()
            val scope = CoroutineScope(scopeJob + mainThread)
            val repo = SessionRepository(scope, creds, dispatchers, autoRestore = false)

            repo.restore()
            withTimeout(5_000) { repo.state.first { it.signedIn } }
            assertEquals(0, scopeJob.children.count { it.isActive })

            repo.foreground(true)
            withTimeout(5_000) {
                while (scopeJob.children.none { it.isActive }) delay(10)
            }
            assertTrue(repo.inForeground.value)

            repo.foreground(false)
            withTimeout(5_000) {
                while (scopeJob.children.any { it.isActive }) delay(10)
            }
            assertFalse(repo.inForeground.value)
            scope.cancel()
        }
    }
}
