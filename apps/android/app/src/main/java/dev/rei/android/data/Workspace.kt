package dev.rei.android.data

import androidx.annotation.StringRes
import dev.rei.android.R
import dev.rei.android.ui.ReiInputException
import dev.rei.android.ui.ReiStateException
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import okhttp3.Request
import java.io.OutputStream

// The workspace calls: Library files and Knowledge pages, typed for the Library, Knowledge and viewer screens.

// ---- Library -------------------------------------------------------------------------------------------------------

/** One immutable version of a file. A reference always pins these bytes. */
data class LibraryVersion(
    val fileId: String,
    val versionId: String,
    val number: Int,
    val name: String,
    val mediaType: String,
    val size: Long,
    val createdAt: Long,
    val creator: String,
)

data class LibraryFile(
    val id: String,
    val name: String,
    val origin: String,
    val creator: String,
    val createdAt: Long,
    val updatedAt: Long,
    val favorite: Boolean,
    val trashedAt: Long?,
    val current: LibraryVersion,
) {
    val trashed get() = trashedAt != null
}

enum class LibraryTab(@StringRes val labelRes: Int) {
    All(R.string.workspace_tab_all),
    Favorites(R.string.workspace_tab_favorites),
    Trash(R.string.workspace_tab_trash),
}

enum class LibrarySort(val query: String, @StringRes val labelRes: Int) {
    Recent("recent", R.string.workspace_sort_recent),
    Oldest("oldest", R.string.workspace_sort_oldest),
    Name("name", R.string.workspace_sort_name),
}

/** What the Library list asks the server for. */
data class LibraryQuery(
    val text: String = "",
    val type: String = "",
    val origin: String = "",
    val sort: LibrarySort = LibrarySort.Recent,
    val tab: LibraryTab = LibraryTab.All,
) {
    /** A search or a type/origin filter is on (the empty state says "No matching files"). */
    val filtered get() = text.isNotBlank() || type.isNotEmpty() || origin.isNotEmpty()

    fun toParameters(cursor: String? = null): Map<String, String> = buildMap {
        if (text.isNotBlank()) put("q", text.trim())
        if (type.isNotEmpty()) put("type", type)
        if (origin.isNotEmpty()) put("origin", origin)
        put("sort", sort.query)
        if (tab == LibraryTab.Trash) put("trash", "1")
        if (tab == LibraryTab.Favorites) put("favorite", "1")
        if (cursor != null) put("cursor", cursor)
    }
}

data class LibraryFiles(val files: List<LibraryFile>, val nextCursor: String?)

data class LibraryDetail(
    val file: LibraryFile,
    val versions: List<LibraryVersion>,
    val folderName: String?,
    val chats: List<Pair<String, String>>,
)

internal fun JsonObject.libraryVersion(fileId: String? = null) = LibraryVersion(
    fileId = fileId ?: string("fileId"),
    versionId = string("versionId"),
    number = getValue("number").jsonPrimitive.int,
    name = string("name"),
    mediaType = string("mediaType"),
    size = getValue("size").jsonPrimitive.long,
    createdAt = getValue("createdAt").jsonPrimitive.long,
    creator = optionalString("creator").orEmpty(),
)

internal fun JsonObject.libraryFile() = LibraryFile(
    id = string("id"),
    name = string("name"),
    origin = string("origin"),
    creator = optionalString("creator").orEmpty(),
    createdAt = getValue("createdAt").jsonPrimitive.long,
    updatedAt = getValue("updatedAt").jsonPrimitive.long,
    favorite = this["favorite"]?.jsonPrimitive?.booleanOrNull ?: false,
    trashedAt = optionalString("trashedAt")?.toLongOrNull(),
    current = obj("current").libraryVersion(string("id")),
)

suspend fun ReiApi.listLibrary(query: LibraryQuery, cursor: String? = null): LibraryFiles {
    val body = request("GET", listOf("api", "files"), query = query.toParameters(cursor))
    return LibraryFiles(body.objects("files").map { it.libraryFile() }, body.optionalString("nextCursor"))
}

suspend fun ReiApi.libraryDetail(id: String): LibraryDetail {
    val body = request("GET", listOf("api", "files", id))
    val file = body.obj("file").libraryFile()
    return LibraryDetail(
        file = file,
        versions = body.objects("versions").map { it.libraryVersion(file.id) },
        folderName = (body["folder"] as? JsonObject)?.optionalString("name"),
        chats = body.objects("chats").map { it.string("id") to it.optionalString("title").orEmpty() },
    )
}

suspend fun ReiApi.setFileFavorite(id: String, favorite: Boolean): LibraryFile =
    request("PATCH", listOf("api", "files", id), buildJsonObject { put("favorite", favorite) }).obj("file").libraryFile()

suspend fun ReiApi.setFileTrashed(id: String, trashed: Boolean): LibraryFile =
    request("PATCH", listOf("api", "files", id), buildJsonObject { put("trashed", trashed) }).obj("file").libraryFile()

/** The bytes of one version, capped; null body means the server answered with no content. */
suspend fun ReiApi.downloadVersionTo(
    fileId: String,
    versionId: String,
    output: OutputStream,
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
) {
    val request: Request = fileRequest(fileId, versionId)
    with(ReiApi.Companion) {
        client.executeStreaming(request, dispatcher) { response ->
            if (!response.isSuccessful) {
                throw ReiStateException(UiText.Resource(R.string.workspace_download_http_failed, response.code))
            }
            val content = response.body ?: throw ReiStateException(UiText.Resource(R.string.workspace_download_failed))
            content.byteStream().use { it.copyTo(output) }
        }
    }
}

// ---- Knowledge -----------------------------------------------------------------------------------------------------

/** A page without its body, for trees and lists. */
data class KnowledgeNode(
    val id: String,
    val parentId: String?,
    val title: String,
    val description: String,
    val updatedAt: Long,
    val updatedBy: String,
    val locked: Boolean,
    val pinned: Boolean,
    val inbox: Boolean,
    val childCount: Int,
    val trashedAt: Long?,
)

data class KnowledgeHit(
    val pageId: String,
    val title: String,
    val path: String,
    val section: String,
    val snippet: String,
    val updatedAt: Long,
)

data class KnowledgeLink(val id: String, val title: String)

data class KnowledgePageData(
    val id: String,
    val parentId: String?,
    val title: String,
    val description: String,
    val tags: List<String>,
    val revision: Int,
    val locked: Boolean,
    val pinned: Boolean,
    val trashedAt: Long?,
    val updatedAt: Long,
    val updatedBy: String,
    val body: String,
    val ancestors: List<KnowledgeLink>,
    val children: List<KnowledgeNode>,
) {
    val trashed get() = trashedAt != null
}

internal fun JsonObject.knowledgeNode() = KnowledgeNode(
    id = string("id"),
    parentId = optionalString("parentId"),
    title = string("title"),
    description = optionalString("description").orEmpty(),
    updatedAt = getValue("updatedAt").jsonPrimitive.long,
    updatedBy = (this["updatedBy"] as? JsonObject)?.optionalString("name").orEmpty(),
    locked = this["locked"]?.jsonPrimitive?.booleanOrNull ?: false,
    pinned = this["pinned"]?.jsonPrimitive?.booleanOrNull ?: false,
    inbox = this["inbox"]?.jsonPrimitive?.booleanOrNull ?: false,
    childCount = this["childCount"]?.jsonPrimitive?.int ?: 0,
    trashedAt = optionalString("trashedAt")?.toLongOrNull(),
)

internal fun JsonObject.knowledgePage(): KnowledgePageData {
    val page = obj("page")
    return KnowledgePageData(
        id = page.string("id"),
        parentId = page.optionalString("parentId"),
        title = page.string("title"),
        description = page.optionalString("description").orEmpty(),
        tags = ((page["metadata"] as? JsonObject)?.get("tags") as? JsonArray).orEmpty().map { it.jsonPrimitive.content },
        revision = page.getValue("revision").jsonPrimitive.int,
        locked = page["locked"]?.jsonPrimitive?.booleanOrNull ?: false,
        pinned = page["pinned"]?.jsonPrimitive?.booleanOrNull ?: false,
        trashedAt = page.optionalString("trashedAt")?.toLongOrNull(),
        updatedAt = page.getValue("updatedAt").jsonPrimitive.long,
        updatedBy = (page["updatedBy"] as? JsonObject)?.optionalString("name").orEmpty(),
        body = optionalString("body").orEmpty(),
        ancestors = objects("ancestors").map { KnowledgeLink(it.string("id"), it.string("title")) },
        children = objects("children").map { it.knowledgeNode() },
    )
}

suspend fun ReiApi.knowledgeTree(): List<KnowledgeNode> =
    request("GET", listOf("api", "knowledge", "tree")).objects("pages").map { it.knowledgeNode() }

suspend fun ReiApi.knowledgeTrash(): List<KnowledgeNode> =
    request("GET", listOf("api", "knowledge", "trash")).objects("pages").map { it.knowledgeNode() }

suspend fun ReiApi.knowledgeTags(): List<String> =
    (request("GET", listOf("api", "knowledge", "tags"))["tags"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }

/** Search by words, tags or both: an empty [query] with tags lists the pages that carry them. */
suspend fun ReiApi.searchKnowledge(query: String, tags: List<String> = emptyList()): List<KnowledgeHit> {
    val parameters = buildMap {
        put("q", query)
        if (tags.isNotEmpty()) put("tags", JsonArray(tags.map(::JsonPrimitive)).toString())
    }
    return request("GET", listOf("api", "knowledge", "search"), query = parameters).objects("hits").map {
        KnowledgeHit(
            pageId = it.string("pageId"),
            title = it.string("title"),
            path = it.optionalString("path").orEmpty(),
            section = it.optionalString("section").orEmpty(),
            snippet = it.optionalString("snippet").orEmpty(),
            updatedAt = it.getValue("updatedAt").jsonPrimitive.long,
        )
    }
}

suspend fun ReiApi.knowledgePage(id: String): KnowledgePageData =
    request("GET", listOf("api", "knowledge", "pages", id)).knowledgePage()

suspend fun ReiApi.createKnowledgePage(title: String, description: String, body: String, tags: List<String>, parentId: String? = null): KnowledgePageData =
    request("POST", listOf("api", "knowledge", "pages"), buildJsonObject {
        put("title", title)
        put("description", description)
        put("body", body)
        put("metadata", buildJsonObject { put("tags", JsonArray(tags.map(::JsonPrimitive))) })
        if (parentId != null) put("parentId", parentId) else put("parentId", JsonNull)
    }).knowledgePage()

/** Saves against the revision the editor opened; a stale one comes back as HTTP 409. */
suspend fun ReiApi.saveKnowledgePage(
    id: String,
    baseRevision: Int,
    title: String,
    description: String,
    body: String,
    tags: List<String>,
): KnowledgePageData = request("PUT", listOf("api", "knowledge", "pages", id), buildJsonObject {
    put("title", title)
    put("description", description)
    put("body", body)
    put("metadata", buildJsonObject { put("tags", JsonArray(tags.map(::JsonPrimitive))) })
    put("baseRevision", baseRevision)
}).knowledgePage()

suspend fun ReiApi.setKnowledgePinned(id: String, pinned: Boolean): KnowledgePageData =
    request("PATCH", listOf("api", "knowledge", "pages", id), buildJsonObject { put("pinned", pinned) }).knowledgePage()

suspend fun ReiApi.trashKnowledgePage(id: String) {
    request("POST", listOf("api", "knowledge", "pages", id, "trash"))
}

suspend fun ReiApi.restoreKnowledgePage(id: String): KnowledgePageData =
    request("POST", listOf("api", "knowledge", "pages", id, "restore")).knowledgePage()

/** Tags as the server normalizes them: whitespace collapsed, deduplicated ignoring case, 1 to 40 characters, at most 20. */
fun addTag(tags: List<String>, entry: String): Result<List<String>> {
    val label = entry.replace(Regex("\\s+"), " ").trim()
    if (label.isEmpty()) return Result.success(tags)
    if (label.codePointCount(0, label.length) > 40) return Result.failure(ReiInputException(UiText.Resource(R.string.workspace_tag_too_long)))
    if (label.any { it.isISOControl() }) return Result.failure(ReiInputException(UiText.Resource(R.string.workspace_tag_control_chars)))
    val key = label.lowercase()
    if (tags.any { it.lowercase() == key }) return Result.success(tags)
    if (tags.size >= 20) return Result.failure(ReiInputException(UiText.Resource(R.string.workspace_tag_limit)))
    return Result.success(tags + label)
}
