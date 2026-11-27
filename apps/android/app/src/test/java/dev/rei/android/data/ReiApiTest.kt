package dev.rei.android.data

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReiApiTest {
    @Test
    fun nativeSignInAndAuthenticatedPaginatedRequest() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":1}"""))
            server.enqueue(json("""{"ok":true,"token":"fixture-device-token","deviceId":"device"}"""))
            server.enqueue(json("""{"sessions":[$SessionJson],"nextCursor":"next"}"""))
            val open = ReiApi(server.url("/").toString())
            assertEquals(Health(2, 1), open.health())
            val token = open.login("fixture password", "123456", "Pixel")
            val page = ReiApi(open.serverUrl, token).sessions("s + ?")
            assertEquals("next", page.nextCursor)
            assertEquals("Chat", page.sessions.single().title)

            val health = server.takeRequest()
            assertEquals("android/1", health.getHeader("x-rei-client"))
            assertNull(health.getHeader("Authorization"))
            val login = server.takeRequest()
            assertEquals("/api/auth/login", login.path)
            assertEquals("123456", Json.parseToJsonElement(login.body.readUtf8()).jsonObject.string("totpCode"))
            val list = server.takeRequest()
            assertEquals("Bearer fixture-device-token", list.getHeader("Authorization"))
            assertEquals("s + ?", list.requestUrl?.queryParameter("before"))
        }
    }

    @Test
    fun permissionLevelIsSavedWithTheSessionPatchTheWebUses() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"session":${sessionWithProfile("yolo")}}"""))
            val saved = ReiApi(server.url("/").toString(), "token").updateSessionProfile("s / ?", ChatProfile.Yolo)
            assertEquals(ChatProfile.Yolo, saved.profile)
            val request = server.takeRequest()
            assertEquals("PATCH", request.method)
            assertEquals("/api/sessions/s%20%2F%20%3F", request.path)
            assertEquals("yolo", Json.parseToJsonElement(request.body.readUtf8()).jsonObject.string("profile"))
        }
    }

    @Test
    fun sessionsReadTheirPermissionLevelAndTreatMissingAndRelaxedAsStandard() = runBlocking {
        MockWebServer().use { server ->
            val sessions = listOf(SessionJson, sessionWithProfile("relaxed"), sessionWithProfile("strict"), sessionWithProfile("yolo"))
            server.enqueue(json("""{"sessions":[${sessions.joinToString(",")}]}"""))
            val levels = ReiApi(server.url("/").toString(), "token").sessions().sessions.map { it.profile }
            assertEquals(listOf(ChatProfile.Standard, ChatProfile.Standard, ChatProfile.Strict, ChatProfile.Yolo), levels)
        }
    }

    @Test
    fun sendRetriesWithSameRequestIdAndEncodedSession() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"error":{"code":"busy","message":"Try again"}}""").setResponseCode(503))
            server.enqueue(json("""{"messageId":"m1","runId":"r1"}"""))
            ReiApi(server.url("/").toString(), "token").sendMessage("s / ?", "request-id", "Hello")
            val first = server.takeRequest()
            val second = server.takeRequest()
            assertEquals("/api/sessions/s%20%2F%20%3F/messages", first.path)
            assertEquals(first.body.readUtf8(), second.body.readUtf8())
        }
    }

    @Test
    fun uploadedFileSendsImmutableLibraryVersion() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"attachment":{"id":"att","fileId":"file","versionId":"v1","name":"sample.txt","size":4}}"""))
            server.enqueue(json("""{"messageId":"m1","runId":"r1"}"""))
            val api = ReiApi(server.url("/").toString(), "token")
            val attachment = api.uploadAttachment("s1", "sample.txt", "test".toRequestBody("text/plain".toMediaType()))
            api.sendMessage("s1", "request-id", "", listOf(attachment))

            val upload = server.takeRequest()
            assertEquals("/api/sessions/s1/attachments", upload.path)
            assertTrue(upload.getHeader("Content-Type")!!.startsWith("multipart/form-data;"))
            assertTrue(upload.body.readUtf8().contains("""name="file"; filename="sample.txt""""))
            val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
            val reference = body.objects("files").single()
            assertEquals(setOf("fileId", "versionId"), reference.keys)
            assertEquals("v1", reference.string("versionId"))
            assertEquals("", body.string("text"))
        }
    }

    @Test
    fun gapReconnectsForSnapshotAndRemovedStopsStream() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(sse(
                snapshot("one", 0) + event("patch", """{"epoch":"one","rev":1,"live":{"runId":"r1"}}""") +
                    event("patch", """{"epoch":"one","rev":3,"live":{"runId":null}}"""),
            ))
            server.enqueue(sse(snapshot("two", 0) + event("session.removed", """{"sessionId":"s1"}""")))
            val events = withTimeout(6_000) {
                ReiApi(server.url("/").toString(), "token").stream("s1").toList()
            }
            assertEquals(4, events.size)
            assertTrue((events[1] as SessionEvent.Updated).detail.busy)
            assertFalse((events[2] as SessionEvent.Updated).detail.busy)
            assertEquals(SessionEvent.Removed, events.last())
            repeat(2) {
                val request = server.takeRequest()
                assertEquals("Bearer token", request.getHeader("Authorization"))
                assertNull(request.getHeader("Last-Event-ID"))
            }
            assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
        }
    }

    @Test
    fun globalStreamResumesFromCommittedCursor() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(sse("id: 9\n" + event(
                "snapshot",
                """{"defaultAgentId":"a","agents":[{"id":"a","name":"Assistant","homeSessionId":"home"}],"sessions":[]}""",
            )))
            server.enqueue(sse("id: 10\n" + event("session.upserted", """{"session":$SessionJson}""")))
            val events = withTimeout(6_000) {
                ReiApi(server.url("/").toString(), "token").globalStream().take(2).toList()
            }
            assertEquals("home", (events.first() as GlobalEvent.Snapshot).homeSessionId)
            assertEquals("s1", (events.last() as GlobalEvent.Upserted).session.id)
            assertNull(server.takeRequest().getHeader("Last-Event-ID"))
            assertEquals("9", server.takeRequest().getHeader("Last-Event-ID"))
        }
    }

    @Test
    fun healthRejectsUnsupportedProtocolBeforeSendingCredentials() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(json("""{"ok":true,"protocolVersion":2,"minClientProtocol":2}"""))
            val result = runCatching { ReiApi(server.url("/").toString()).health() }.exceptionOrNull()
            assertTrue(result is ReiApiException)
            assertEquals(426, (result as ReiApiException).status)
            assertEquals("client_outdated", result.code)
        }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

    private fun sse(body: String) = MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body)

    private fun snapshot(epoch: String, revision: Long): String = event(
        "snapshot",
        """{"epoch":"$epoch","rev":$revision,"view":{"version":2,"session":$SessionJson,"items":[],"runs":[],"live":{"runId":null}}}""",
    )

    private fun event(type: String, data: String): String = "event: $type\ndata: $data\n\n"

    private companion object {
        fun sessionWithProfile(profile: String) = SessionJson.replace("\"unread\":0", "\"unread\":0,\"profile\":\"$profile\"")

        const val SessionJson = """{"id":"s1","agentId":"a","title":"Chat","preview":"","origin":"user","status":"idle","unread":0}"""
    }
}
