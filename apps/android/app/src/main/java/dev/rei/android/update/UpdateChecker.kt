package dev.rei.android.update

import dev.rei.android.BuildConfig
import dev.rei.android.data.ReiApi
import dev.rei.android.readUpTo
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody

sealed interface UpdateCheck {
    /** No feed URL is configured: update checks are off. */
    data object Disabled : UpdateCheck

    data object UpToDate : UpdateCheck

    data class Available(val feed: UpdateFeed) : UpdateCheck
}

/** Whether [feed] is newer than the running build and can run on this device. */
internal fun UpdateFeed.isUpdateFor(currentVersionCode: Int, sdkInt: Int): Boolean =
    versionCode > currentVersionCode && minSdk <= sdkInt

/** Automatic checks run at most once a day. [lastCheckMillis] is 0 when there has been none. */
internal fun updateCheckDue(lastCheckMillis: Long, nowMillis: Long, intervalMillis: Long = CheckInterval): Boolean =
    lastCheckMillis <= 0 || nowMillis < lastCheckMillis || nowMillis - lastCheckMillis >= intervalMillis

internal const val CheckInterval = 24L * 60 * 60 * 1000

private const val MaxFeedBytes = 64 * 1024

/** The largest update APK that is downloaded. Rei's own APK is a fraction of this; the cap stops a hostile or broken server filling the disk. */
internal const val MaxApkBytes = 256L * 1024 * 1024

/**
 * Reads the update feed and downloads the APK it points to. It has no Android dependencies beyond the app's OkHttp, so the
 * logic runs in plain unit tests. An empty [feedUrl] means checks are off ([check] returns [UpdateCheck.Disabled]).
 *
 * The feed and the APK are fetched over HTTPS (loopback HTTP is allowed only when [allowLoopbackHttp] is set, for debug builds and tests). The digest in the feed catches a
 * truncated or swapped download; Android itself decides whether the APK is signed with this app's key.
 */
class UpdateChecker(
    private val feedUrl: String,
    private val currentVersionCode: Int,
    private val sdkInt: Int,
    // GitHub serves release assets through a redirect, which the API client does not follow. The pool and timeouts are shared.
    // Redirects are followed, but never from HTTPS to HTTP (followSslRedirects(false)).
    private val client: OkHttpClient = ReiApi.http.newBuilder().followRedirects(true).followSslRedirects(false).build(),
    private val allowLoopbackHttp: Boolean = BuildConfig.DEBUG,
    private val maxApkBytes: Long = MaxApkBytes,
) {
    val enabled: Boolean get() = feedUrl.isNotBlank()

    suspend fun check(): UpdateCheck {
        if (!enabled) return UpdateCheck.Disabled
        val url = secureUrl(feedUrl.trim()) ?: throw UpdateException("The update feed address is not valid.")
        val body = withContext(Dispatchers.IO) {
            try {
                client.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { response ->
                    if (!response.isSuccessful) throw UpdateException("The update feed returned HTTP ${response.code}.")
                    String(response.requireBody().byteStream().readUpTo(MaxFeedBytes + 1), Charsets.UTF_8)
                }
            } catch (failure: UpdateException) {
                throw failure
            } catch (_: IOException) {
                throw UpdateException("Couldn’t reach the update server. Check your connection and try again.")
            }
        }
        if (body.length > MaxFeedBytes) throw UpdateException("The update feed is too large.")
        val feed = UpdateFeed.parse(body)
        return if (feed.isUpdateFor(currentVersionCode, sdkInt)) UpdateCheck.Available(feed) else UpdateCheck.UpToDate
    }

    /**
     * Streams the APK to [target] and checks its SHA-256 against the feed. A partial or mismatching file is deleted, so
     * [target] exists only when it is complete and verified. [onProgress] gets (bytes so far, total or -1) on the calling IO thread.
     */
    suspend fun download(feed: UpdateFeed, target: File, onProgress: (Long, Long) -> Unit = { _, _ -> }) {
        val url = secureUrl(feed.apkUrl) ?: throw UpdateException("The update download address is not valid.")
        withContext(Dispatchers.IO) {
            target.parentFile?.mkdirs()
            val partial = File(target.parentFile, target.name + ".part")
            partial.delete()
            target.delete()
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                client.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    if (!response.isSuccessful) throw UpdateException("The update download returned HTTP ${response.code}.")
                    val responseBody = response.requireBody()
                    val total = responseBody.contentLength()
                    if (total > maxApkBytes) throw UpdateException("The update is larger than Rei accepts, so it was not downloaded.")
                    var received = 0L
                    var reported = -1L
                    responseBody.byteStream().use { input ->
                        partial.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                ensureActive()
                                val n = input.read(buffer)
                                if (n < 0) break
                                output.write(buffer, 0, n)
                                digest.update(buffer, 0, n)
                                received += n
                                if (received > maxApkBytes) throw UpdateException("The update is larger than Rei accepts, so the download was stopped.")
                                // About a hundred updates per download keeps the UI calm.
                                val step = if (total > 0) received * 100 / total else received / (256 * 1024)
                                if (step != reported) { reported = step; onProgress(received, total) }
                            }
                        }
                    }
                    if (total >= 0 && received != total) throw UpdateException("The update download was cut short.")
                }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                if (!actual.equals(feed.sha256, ignoreCase = true)) {
                    throw UpdateException("The downloaded update did not match its checksum, so it was discarded.")
                }
                if (!partial.renameTo(target)) throw UpdateException("The update could not be saved on this device.")
            } catch (failure: UpdateException) {
                throw failure
            } catch (_: IOException) {
                throw UpdateException("The update download was interrupted. Check your connection and try again.")
            } finally {
                partial.delete()
            }
        }
    }

    private fun Response.requireBody(): ResponseBody = body ?: throw UpdateException("The update server sent an empty response.")

    private fun secureUrl(raw: String): HttpUrl? = raw.toHttpUrlOrNull()?.takeIf { it.isHttps || (allowLoopbackHttp && it.host in Loopback) }

    private companion object {
        val Loopback = setOf("localhost", "127.0.0.1", "::1", "[::1]")
    }
}
