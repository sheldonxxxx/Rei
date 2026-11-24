package dev.rei.android.feature.viewer

/** What the viewer can show a file as. Mirrors `filePreview` in the protocol: known extensions first, then the media type. */
enum class PreviewKind { Text, Markdown, Html, Csv, Image, Pdf, Audio, Video, Office, Unsupported }

private val byExtension: Map<String, PreviewKind> = buildMap {
    fun add(names: String, kind: PreviewKind) = names.split(" ").forEach { put(it, kind) }
    add("txt log ini cfg conf env sh bash zsh py js jsx ts tsx css scss sql c h cpp hpp java go rs rb php swift toml yaml yml json jsonl xml tex diff patch eml", PreviewKind.Text)
    add("md markdown mdx", PreviewKind.Markdown)
    add("html htm", PreviewKind.Html)
    add("csv tsv", PreviewKind.Csv)
    add("png jpg jpeg gif webp avif bmp ico svg", PreviewKind.Image)
    add("pdf", PreviewKind.Pdf)
    add("mp3 wav ogg m4a aac flac", PreviewKind.Audio)
    add("mp4 webm mov ogv", PreviewKind.Video)
    add("doc docx dot dotx xls xlsx xlt xltx xlsm xltm xlsb ppt pptx pps ppsx pot potx odt ods odp rtf", PreviewKind.Office)
}

private val officeTypes = setOf(
    "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/rtf", "text/rtf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
)

fun previewKind(name: String, mediaType: String): PreviewKind {
    byExtension[name.substringAfterLast('.', "").lowercase()]?.let { return it }
    val type = mediaType.substringBefore(';').trim().lowercase()
    return when {
        type in officeTypes -> PreviewKind.Office
        type == "application/pdf" -> PreviewKind.Pdf
        type.startsWith("image/") -> PreviewKind.Image
        type == "text/markdown" -> PreviewKind.Markdown
        type == "text/html" -> PreviewKind.Html
        type == "text/csv" || type == "text/tab-separated-values" -> PreviewKind.Csv
        type.startsWith("audio/") -> PreviewKind.Audio
        type.startsWith("video/") -> PreviewKind.Video
        type.startsWith("text/") -> PreviewKind.Text
        else -> PreviewKind.Unsupported
    }
}

/** The short label on a card without a thumbnail: the extension, upper case, at most eight characters. */
fun typeLabel(name: String): String = name.substringAfterLast('.', "").take(8).uppercase().ifEmpty { "FILE" }

/** The same byte sizes as web: 1.2 KiB, 3.4 MiB. */
fun fileBytes(size: Long): String = when {
    size < 1024 -> "$size B"
    size < 1024 * 1024 -> String.format(java.util.Locale.ROOT, "%.1f KiB", size / 1024.0)
    else -> String.format(java.util.Locale.ROOT, "%.1f MiB", size / 1024.0 / 1024.0)
}
