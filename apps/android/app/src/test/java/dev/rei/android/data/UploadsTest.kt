package dev.rei.android.data

import java.io.ByteArrayInputStream
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadsTest {
    private fun copy(size: Int, limit: Long): Buffer {
        val sink = Buffer()
        copyWithinLimit(ByteArrayInputStream(ByteArray(size) { it.toByte() }), sink, limit)
        return sink
    }

    @Test
    fun streamWithinTheLimitIsCopiedWhole() {
        assertEquals(20_000L, copy(20_000, limit = 20_000).size)
        assertEquals(0L, copy(0, limit = 10).size)
    }

    @Test
    fun streamOverTheLimitFailsAsTooLargeEvenWhenTheSizeWasNotKnown() {
        val failure = runCatching { copy(20_001, limit = 20_000) }.exceptionOrNull()
        assertTrue(failure is ReiApiException)
        assertEquals(413, (failure as ReiApiException).status)
    }

    @Test
    fun theUploadLimitIsOneGibibyte() {
        assertEquals(1024L * 1024 * 1024, MaxUploadBytes)
    }
}
