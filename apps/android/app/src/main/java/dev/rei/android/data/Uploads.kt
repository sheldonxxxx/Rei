package dev.rei.android.data

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.Buffer
import okio.BufferedSink
import okio.source

fun ContentResolver.uploadBody(uri: Uri): Pair<String, RequestBody> {
    var filename = "Attachment"
    var size = -1L
    query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            if (nameIndex >= 0) filename = cursor.getString(nameIndex)?.takeIf { it.isNotBlank() } ?: filename
            if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
        }
    }
    if (size > MaxUploadBytes) throw attachmentTooLarge()
    val type = getType(uri)?.toMediaTypeOrNull() ?: "application/octet-stream".toMediaTypeOrNull()
    return filename to object : RequestBody() {
        override fun contentType(): MediaType? = type

        // Some document providers return unreliable sizes. Cap the actual stream and let OkHttp frame it.
        override fun isOneShot(): Boolean = true

        override fun writeTo(sink: BufferedSink) {
            val input = openInputStream(uri)
                ?: throw ReiApiException(0, "missing_document", "Could not read the selected file.")
            input.source().use { source ->
                val buffer = Buffer()
                var total = 0L
                while (true) {
                    val sizeRead = source.read(buffer, 8_192L)
                    if (sizeRead < 0) break
                    total += sizeRead
                    if (total > MaxUploadBytes) throw attachmentTooLarge()
                    sink.write(buffer, sizeRead)
                }
            }
        }
    }
}

private const val MaxUploadBytes = 1024L * 1024 * 1024
private fun attachmentTooLarge() = ReiApiException(413, "attachment_too_large", "Files can be at most 1 GiB.")
