package dev.rei.android.data

import android.content.SharedPreferences
import dev.rei.android.di.AppDispatchers
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatCatalogRepositoryTest {
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

    private class InMemoryPreferences : SharedPreferences {
        val data: MutableMap<String, Any?> = Collections.synchronizedMap(linkedMapOf())
        override fun getAll(): MutableMap<String, *> = data.toMutableMap()
        override fun getString(key: String?, defValue: String?): String? = (data[key] as? String) ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String?, defValue: Int): Int = (data[key] as? Int) ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = (data[key] as? Long) ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = (data[key] as? Float) ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = (data[key] as? Boolean) ?: defValue
        override fun contains(key: String?): Boolean = data.containsKey(key)
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = linkedMapOf<String, Any?>()
            private var cleared = false
            override fun putString(key: String?, value: String?) = apply { if (key != null) pending[key] = value }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { }
            override fun putInt(key: String?, value: Int) = apply { if (key != null) pending[key] = value }
            override fun putLong(key: String?, value: Long) = apply { if (key != null) pending[key] = value }
            override fun putFloat(key: String?, value: Float) = apply { if (key != null) pending[key] = value }
            override fun putBoolean(key: String?, value: Boolean) = apply { if (key != null) pending[key] = value }
            override fun remove(key: String?) = apply { if (key != null) pending[key] = null }
            override fun clear() = apply { cleared = true }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() {
                synchronized(data) {
                    if (cleared) data.clear()
                    for ((k, v) in pending) if (v == null) data.remove(k) else data[k] = v
                }
            }
        }
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
    }

    private class FakeCredentials(@Volatile var saved: SavedConnection? = null) : CredentialsGateway {
        override fun load(): SavedConnection? = saved
        override fun save(serverUrl: String, token: String?) { saved = SavedConnection(serverUrl, token) }
        override fun clear() { saved = null }
    }

    private fun sessionJson(id: String, title: String, pinned: Boolean = false) =
        """{"id":"$id","agentId":"a1","title":"$title","preview":"","origin":"user","status":"idle","unread":0,"pinned":$pinned,"updatedAt":2}"""

    @Test
    fun mutationsDoNotBlockBehindInFlightCatalogLoadAndDeleteClearsDrafts() = runBlocking {
        val listStarted = CountDownLatch(1)
        val releaseList = CountDownLatch(1)
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl?.encodedPath) {
                    "/api/health" -> MockResponse().setBody("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}""")
                    "/api/auth/state" -> MockResponse().setBody("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}""")
                    "/api/sessions" -> when (request.method) {
                        "GET" -> {
                            listStarted.countDown()
                            releaseList.await(5, TimeUnit.SECONDS)
                            MockResponse().setBody("""{"sessions":[${sessionJson("s1", "First")}],"nextCursor":null}""")
                        }
                        "POST" -> MockResponse().setBody("""{"session":${sessionJson("s2", "Created")}}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                    "/api/sessions/s2" -> when (request.method) {
                        "PATCH" -> MockResponse().setBody("""{"session":${sessionJson("s2", "Pinned", pinned = true)}}""")
                        "DELETE" -> MockResponse().setBody("""{"ok":true}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials(SavedConnection(url, "tok"))
            val prefs = InMemoryPreferences()
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val session = SessionRepository(scope, creds, dispatchers, autoRestore = false)
            val catalog = ChatCatalogRepository(scope, session, prefs, dispatchers)

            session.restore()
            withTimeout(5_000) { session.state.first { it.signedIn } }

            // Start a slow refreshChats() that blocks on releaseList.
            catalog.refreshChats()
            assertTrue(listStarted.await(5, TimeUnit.SECONDS))

            // newChat() must proceed without waiting for refreshChats() to finish.
            catalog.newChat()
            val createdState = withTimeout(5_000) { catalog.state.first { it.sessionId == "s2" } }
            assertTrue(createdState.sessions.any { it.id == "s2" })

            releaseList.countDown()
            withTimeout(5_000) { catalog.state.first { !it.loading } }

            // Save a draft for s2 and then delete s2; both s2 and its draft keys must disappear.
            prefs.edit().putString("draft:$url:s2", "unsent text").apply()
            catalog.pinChat("s2", true)
            withTimeout(5_000) { catalog.state.first { s -> s.sessions.any { it.id == "s2" && it.pinned } } }

            catalog.deleteChat("s2", deleteForks = false)
            val deletedState = withTimeout(5_000) { catalog.state.first { s -> s.sessions.none { it.id == "s2" } } }
            assertNull(deletedState.sessionId)
            assertNull(prefs.getString("draft:$url:s2", null))
            scope.cancel()
        }
    }

    @Test
    fun signOutClearsPreferencesAndResetsCatalog() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(MockResponse().setBody("""{"setupRequired":false,"signedIn":true,"totpEnabled":false}"""))
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            val url = server.url("/").toString().removeSuffix("/")
            val creds = FakeCredentials(SavedConnection(url, "tok"))
            val prefs = InMemoryPreferences()
            val scope = CoroutineScope(SupervisorJob() + mainThread)
            val session = SessionRepository(scope, creds, dispatchers, autoRestore = false)
            val catalog = ChatCatalogRepository(scope, session, prefs, dispatchers)

            session.restore()
            withTimeout(5_000) { session.state.first { it.signedIn } }
            catalog.openChat("chat-1")
            withTimeout(5_000) { catalog.state.first { it.sessionId == "chat-1" } }
            assertEquals("chat-1", prefs.getString("last:$url", null))

            session.disconnect()
            withTimeout(5_000) { session.state.first { !it.signedIn } }
            val resetState = withTimeout(5_000) { catalog.state.first { it.sessionId == null } }
            assertFalse(resetState.historyLoaded)
            assertTrue(prefs.data.isEmpty())
            scope.cancel()
        }
    }
}
