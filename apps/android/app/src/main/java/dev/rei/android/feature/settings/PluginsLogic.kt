package dev.rei.android.feature.settings

import dev.rei.android.data.array
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.Base64

/**
 * Pure rules for the Plugins pages, following the web's: a plugin package (skills and MCP connections) as the editor changes
 * it, and the small requests that install, enable and restore one. The server validates every package; nothing here keeps a
 * credential, since a package never carries one.
 */

internal data class PluginRow(
    val id: String,
    val name: String,
    val description: String,
    val revision: Long,
    val enabled: Boolean,
    val agents: List<String>?,
    val builtIn: Boolean,
    val skillCount: Long,
    val connectionCount: Long,
) {
    /** What the plugin brings, as the web labels it. */
    val kind get() = if (skillCount > 0 && connectionCount > 0) "Skills + Connectors" else if (skillCount > 0) "Skills" else "Connectors"
}

internal fun JsonObject.pluginRow() = PluginRow(
    string("id"), string("name"), optionalString("description").orEmpty(), optionalString("revision")?.toLongOrNull() ?: 1,
    optionalString("enabled") != "false", array("agents")?.map { it.jsonPrimitive.content }, optionalString("builtIn") == "true",
    optionalString("skillCount")?.toLongOrNull() ?: 0, optionalString("connectionCount")?.toLongOrNull() ?: 0,
)

internal data class PackageSkill(val name: String, val files: List<SkillFile>) {
    val skillMd: String get() = files.firstOrNull { it.path == "SKILL.md" }?.content.orEmpty()
}

internal data class PackageConnection(val name: String, val url: String, val auth: String, val skills: List<String>)

internal data class PluginPackage(val name: String, val description: String, val skills: List<PackageSkill>, val mcp: List<PackageConnection>)

internal fun JsonObject.pluginPackage() = PluginPackage(
    string("name"), optionalString("description").orEmpty(),
    objects("skills").map { skill -> PackageSkill(skill.string("name"), skill.objects("files").map { it.skillFile() }) },
    objects("mcp").map { c -> PackageConnection(c.string("name"), c.string("url"), c.optionalString("auth") ?: "none", c.array("skills")?.map { it.jsonPrimitive.content }.orEmpty()) },
)

internal fun PluginPackage.toJson(): JsonObject = buildJsonObject {
    put("formatVersion", 1)
    put("name", name)
    put("description", description)
    put("skills", buildJsonArray { skills.forEach { s -> add(buildJsonObject { put("name", s.name); put("files", JsonArray(s.files.map { it.toJson() })) }) } })
    put("mcp", buildJsonArray {
        mcp.forEach { c ->
            add(buildJsonObject { put("name", c.name); put("url", c.url); put("auth", c.auth); put("skills", buildJsonArray { c.skills.forEach { add(JsonPrimitive(it)) } }) })
        }
    })
}

internal fun emptyPackage() = PluginPackage("", "", emptyList(), emptyList())

internal data class PluginConnection(val name: String, val connectorId: String?, val status: String, val error: String?)

internal data class PluginDetailData(
    val row: PluginRow,
    val pkg: PluginPackage,
    val selectedRevision: Long,
    val revisions: List<PluginRevision>,
    val connections: List<PluginConnection>,
)

internal data class PluginRevision(val revision: Long, val author: String, val createdAt: Long?)

internal fun pluginDetail(body: JsonObject): PluginDetailData {
    val plugin = body.obj("plugin")
    return PluginDetailData(
        plugin.pluginRow(), plugin.obj("package").pluginPackage(), plugin.optionalString("selectedRevision")?.toLongOrNull() ?: 1,
        plugin.objects("revisions").map { PluginRevision(it.optionalString("revision")?.toLongOrNull() ?: 0, it.optionalString("author") ?: "user", it.optionalString("createdAt")?.toLongOrNull()) },
        plugin.objects("connections").map { PluginConnection(it.string("name"), it.optionalString("connectorId"), it.optionalString("status") ?: "pending", it.optionalString("error")) },
    )
}

internal fun connectionStatusWord(status: String?) = when (status) {
    "ready" -> "Connected"
    "needs_auth" -> "Needs sign-in"
    "error" -> "Error"
    else -> "Pending"
}

internal val ConnectionAuth = listOf(Choice("none", "None"), Choice("oauth", "Sign in with OAuth"), Choice("token", "API token"))

// ---- editing a package ----

internal fun PluginPackage.addSkill(): PluginPackage {
    val name = "skill-${skills.size + 1}"
    val md = "---\nname: $name\ndescription: Describe when to use this skill.\n---\n\nWrite the instructions here.\n"
    return copy(skills = skills + PackageSkill(name, listOf(SkillFile("SKILL.md", "text", md))))
}

/** Renames a skill and keeps every connection's "skills to read first" pointing at it. */
internal fun PluginPackage.renameSkill(index: Int, name: String): PluginPackage {
    val old = skills.getOrNull(index)?.name ?: return this
    return copy(
        skills = skills.mapIndexed { i, s -> if (i == index) s.copy(name = name) else s },
        mcp = mcp.map { c -> c.copy(skills = c.skills.map { if (it == old) name else it }) },
    )
}

internal fun PluginPackage.setSkillMd(index: Int, content: String): PluginPackage =
    copy(skills = skills.mapIndexed { i, s -> if (i == index) s.copy(files = withSkillMd(s.files, content)) else s })

internal fun PluginPackage.removeSkill(index: Int): PluginPackage {
    val gone = skills.getOrNull(index)?.name ?: return this
    return copy(skills = skills.filterIndexed { i, _ -> i != index }, mcp = mcp.map { c -> c.copy(skills = c.skills.filter { it != gone }) })
}

internal fun PluginPackage.addConnection() = copy(mcp = mcp + PackageConnection("connection-${mcp.size + 1}", "", "none", emptyList()))

internal fun PluginPackage.updateConnection(index: Int, change: (PackageConnection) -> PackageConnection): PluginPackage =
    copy(mcp = mcp.mapIndexed { i, c -> if (i == index) change(c) else c })

internal fun PluginPackage.removeConnection(index: Int) = copy(mcp = mcp.filterIndexed { i, _ -> i != index })

internal fun PackageConnection.withSkill(name: String, on: Boolean) = copy(skills = if (on) (skills - name) + name else skills - name)

/** The first thing wrong with a package the server would refuse for being empty, in words; null when it can be sent. */
internal fun packageProblem(pkg: PluginPackage): String? = when {
    pkg.name.isBlank() -> "Give the plugin a name."
    pkg.description.isBlank() -> "Describe what the plugin does."
    pkg.skills.isEmpty() && pkg.mcp.isEmpty() -> "Add at least one skill or connection."
    pkg.skills.any { it.name.isBlank() } -> "Every skill needs a name."
    pkg.mcp.any { it.name.isBlank() } -> "Every connection needs a name."
    pkg.mcp.any { it.url.isBlank() } -> "Every connection needs a server address."
    else -> null
}

internal fun savePluginBody(pkg: PluginPackage, expectedRevision: Long?): JsonObject = buildJsonObject {
    put("package", pkg.toJson())
    if (expectedRevision != null) put("expectedRevision", expectedRevision)
}

internal fun enabledBody(enabled: Boolean): JsonObject = buildJsonObject { put("enabled", enabled) }

/** "All agents" is null; turning it off starts from an empty list the user then ticks. */
internal fun allAgentsBody(all: Boolean): JsonObject = buildJsonObject { put("agents", if (all) JsonNull else JsonArray(emptyList())) }

internal fun agentToggleBody(current: List<String>, id: String, on: Boolean): JsonObject = buildJsonObject {
    put("agents", buildJsonArray { (if (on) (current - id) + id else current - id).forEach { add(JsonPrimitive(it)) } })
}

internal fun pluginZipBody(bytes: ByteArray): JsonObject = buildJsonObject { put("zip", Base64.getEncoder().encodeToString(bytes)) }

private val Pretty = Json { prettyPrint = true }

/** A revision's package as indented JSON, for reading. */
internal fun prettyPackage(pkg: PluginPackage): String = Pretty.encodeToString(JsonObject.serializer(), pkg.toJson())
