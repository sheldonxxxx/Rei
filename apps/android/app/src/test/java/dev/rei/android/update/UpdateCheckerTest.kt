package dev.rei.android.update

import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UpdateCheckerTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val apk = ByteArray(200_000) { (it % 251).toByte() }
    private val apkSha = sha256(apk)

    @Test
    fun feedParsesAndIgnoresUnknownFields() {
        val feed = UpdateFeed.parse(
            """{"versionCode":7,"versionName":"0.2.0","apkUrl":"https://example.test/rei.apk","sha256":"$apkSha",
               "minSdk":28,"notes":"Faster chat.","channel":"stable","size":123}""",
        )
        assertEquals(UpdateFeed(7, "0.2.0", "https://example.test/rei.apk", apkSha, 28, "Faster chat."), feed)
    }

    @Test
    fun feedWithoutOptionalFieldsUsesDefaults() {
        val feed = UpdateFeed.parse("""{"versionCode":2,"versionName":"0.1.1","apkUrl":"https://example.test/a.apk","sha256":"$apkSha"}""")
        assertEquals(0, feed.minSdk)
        assertEquals("", feed.notes)
    }

    @Test
    fun malformedOrIncompleteFeedsAreRejectedWithAReadableMessage() {
        val problems = listOf(
            "not json",
            """{"versionName":"1"}""",
            """{"versionCode":0,"versionName":"1","apkUrl":"https://e.test/a.apk","sha256":"$apkSha"}""",
            """{"versionCode":2,"versionName":"1","apkUrl":"","sha256":"$apkSha"}""",
            """{"versionCode":2,"versionName":"1","apkUrl":"https://e.test/a.apk","sha256":"abc"}""",
        )
        for (raw in problems) {
            val failure = runCatching { UpdateFeed.parse(raw) }.exceptionOrNull()
            assertTrue("$raw -> $failure", failure is UpdateException)
        }
    }

    @Test
    fun versionComparisonNeedsAHigherCodeAndASupportedSdk() {
        fun feed(code: Long, minSdk: Int) = UpdateFeed(code, "x", "https://e.test/a.apk", apkSha, minSdk)
        assertTrue(feed(2, 28).isUpdateFor(currentVersionCode = 1, sdkInt = 34))
        assertFalse(feed(1, 28).isUpdateFor(currentVersionCode = 1, sdkInt = 34))
        assertFalse(feed(1, 0).isUpdateFor(currentVersionCode = 3, sdkInt = 34))
        assertTrue(feed(5, 34).isUpdateFor(currentVersionCode = 4, sdkInt = 34))
        assertFalse(feed(5, 35).isUpdateFor(currentVersionCode = 4, sdkInt = 34))
    }

    @Test
    fun checksRunAtMostOncePerDay() {
        val day = CheckInterval
        assertTrue(updateCheckDue(0, 1_000))
        assertFalse(updateCheckDue(1_000, 1_000 + day - 1))
        assertTrue(updateCheckDue(1_000, 1_000 + day))
        // A clock that moved backwards must not block checks until it catches up.
        assertTrue(updateCheckDue(10_000, 5_000))
    }

    @Test
    fun emptyFeedUrlTurnsChecksOffWithoutAnyRequest() = runBlocking {
        MockWebServer().use { server ->
            val checker = UpdateChecker("", currentVersionCode = 1, sdkInt = 34)
            assertFalse(checker.enabled)
            assertEquals(UpdateCheck.Disabled, checker.check())
            assertEquals(0, server.requestCount)
            assertEquals(UpdateCheck.Disabled, UpdateChecker("   ", 1, 34).check())
        }
    }

    @Test
    fun newerFeedIsAvailableAndSameOrOlderIsUpToDate() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(feedResponse(server, versionCode = 2))
            server.enqueue(feedResponse(server, versionCode = 1))
            server.enqueue(feedResponse(server, versionCode = 3, minSdk = 99))
            val checker = checker(server)
            val first = checker.check()
            assertTrue(first is UpdateCheck.Available)
            assertEquals("0.2.0", (first as UpdateCheck.Available).feed.versionName)
            assertEquals(UpdateCheck.UpToDate, checker.check())
            assertEquals(UpdateCheck.UpToDate, checker.check())
            assertEquals("/android-update.json", server.takeRequest().path)
        }
    }

    @Test
    fun feedFailuresSurfaceAsUpdateExceptions() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(404))
            server.enqueue(MockResponse().setBody("{ nope"))
            val checker = checker(server)
            assertTrue(runCatching { checker.check() }.exceptionOrNull() is UpdateException)
            assertTrue(runCatching { checker.check() }.exceptionOrNull() is UpdateException)
        }
    }

    @Test
    fun plainHttpToAnotherHostIsRefused() = runBlocking {
        val checker = UpdateChecker("http://example.test/android-update.json", 1, 34)
        val failure = runCatching { checker.check() }.exceptionOrNull()
        assertTrue(failure is UpdateException)
    }

    @Test
    fun loopbackHttpIsRefusedUnlessTheBuildAllowsIt() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(feedResponse(server, versionCode = 2))
            val url = server.url("/android-update.json").toString()
            val failure = runCatching { UpdateChecker(url, 1, 34, allowLoopbackHttp = false).check() }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertEquals(0, server.requestCount)
        }
    }

    @Test
    fun redirectsBetweenHttpAndHttpsAreNotFollowed() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://example.test/rei.apk"))
            val target = File(temp.root, "updates/rei-2.apk")
            val failure = runCatching { checker(server).download(feed(server, apkSha), target) }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertTrue(failure!!.message!!.contains("HTTP 302"))
            assertFalse(target.exists())
        }
    }

    @Test
    fun redirectsOnTheSameSchemeAreFollowed() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/real.apk").toString()))
            server.enqueue(MockResponse().setBody(okio.Buffer().write(apk)))
            val target = File(temp.root, "rei.apk")
            checker(server).download(feed(server, apkSha), target)
            assertTrue(target.isFile)
        }
    }

    @Test
    fun downloadLargerThanTheCapIsRefusedByItsDeclaredLength() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(okio.Buffer().write(apk)))
            val target = File(temp.root, "updates/rei-2.apk")
            val small = UpdateChecker(server.url("/f.json").toString(), 1, 34, allowLoopbackHttp = true, maxApkBytes = 1_000)
            val failure = runCatching { small.download(feed(server, apkSha), target) }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertTrue(failure!!.message!!.contains("larger"))
            assertFalse(target.exists())
            assertEquals(emptyList<String>(), target.parentFile!!.list()!!.toList())
        }
    }

    @Test
    fun downloadThatOutgrowsTheCapWithoutADeclaredLengthIsStopped() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setChunkedBody(okio.Buffer().write(apk), 4096))
            val target = File(temp.root, "updates/rei-2.apk")
            val small = UpdateChecker(server.url("/f.json").toString(), 1, 34, allowLoopbackHttp = true, maxApkBytes = 50_000)
            val failure = runCatching { small.download(feed(server, apkSha), target) }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertTrue(failure!!.message!!.contains("larger"))
            assertEquals(emptyList<String>(), target.parentFile!!.list()!!.toList())
        }
    }

    @Test
    fun downloadStreamsAndKeepsAFileWhoseDigestMatches() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(okio.Buffer().write(apk)))
            val target = File(temp.root, "updates/rei-2.apk")
            val progress = mutableListOf<Long>()
            checker(server).download(feed(server, apkSha), target) { received, _ -> progress += received }
            assertTrue(target.isFile)
            assertEquals(apkSha, sha256(target.readBytes()))
            assertEquals(apk.size.toLong(), progress.last())
            assertEquals(listOf("rei-2.apk"), target.parentFile!!.list()!!.toList())
        }
    }

    @Test
    fun downloadWithTheWrongDigestIsDeleted() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(okio.Buffer().write(apk)))
            val target = File(temp.root, "updates/rei-2.apk")
            val wrong = sha256(byteArrayOf(1, 2, 3))
            val failure = runCatching { checker(server).download(feed(server, wrong), target) }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertTrue(failure!!.message!!.contains("checksum"))
            assertFalse(target.exists())
            assertEquals(emptyList<String>(), target.parentFile!!.list()!!.toList())
        }
    }

    @Test
    fun digestComparisonIgnoresCase() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(okio.Buffer().write(apk)))
            val target = File(temp.root, "rei.apk")
            checker(server).download(feed(server, apkSha.uppercase()), target)
            assertTrue(target.isFile)
        }
    }

    @Test
    fun failedDownloadLeavesNoFile() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(500))
            val target = File(temp.root, "updates/rei-2.apk")
            val failure = runCatching { checker(server).download(feed(server, apkSha), target) }.exceptionOrNull()
            assertTrue(failure is UpdateException)
            assertNull(target.parentFile!!.list()!!.firstOrNull())
        }
    }

    private fun checker(server: MockWebServer) =
        UpdateChecker(server.url("/android-update.json").toString(), currentVersionCode = 1, sdkInt = 34, allowLoopbackHttp = true)

    private fun feed(server: MockWebServer, sha: String) =
        UpdateFeed(2, "0.2.0", server.url("/rei-0.2.0.apk").toString(), sha, 28, "")

    private fun feedResponse(server: MockWebServer, versionCode: Long, minSdk: Int = 28) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(
            """{"versionCode":$versionCode,"versionName":"0.$versionCode.0","apkUrl":"${server.url("/rei.apk")}",
               "sha256":"$apkSha","minSdk":$minSdk,"notes":"n"}""",
        )

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
