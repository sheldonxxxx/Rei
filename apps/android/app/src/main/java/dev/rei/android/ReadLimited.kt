package dev.rei.android

import java.io.InputStream

/** Reads at most [limit] bytes (`InputStream.readNBytes` needs API 33; the app's minimum is 28). */
internal fun InputStream.readUpTo(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var remaining = limit
    while (remaining > 0) {
        val n = read(buffer, 0, minOf(buffer.size, remaining))
        if (n < 0) break
        out.write(buffer, 0, n)
        remaining -= n
    }
    return out.toByteArray()
}
