package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.data.array
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
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
 * Pure rules for the Skills pages, following the web's: how a SKILL.md reads, how a new one is written, how an import is
 * packed and how the agent allow-list is saved. The server parses and validates every skill for real; these only prepare it.
 */

internal data class SkillSummary(
    val id: String,
    val name: String,
    val description: String,
    val version: Long,
    /** Null: every agent sees it. */
    val agents: List<String>?,
    val author: String,
    val builtIn: Boolean,
    val pluginId: String?,
    val pluginName: String?,
    val pluginEnabled: Boolean,
    val updatedAt: Long?,
)

internal fun JsonObject.skillSummary(): SkillSummary {
    val plugin = this["plugin"] as? JsonObject
    return SkillSummary(
        id = string("id"), name = string("name"), description = optionalString("description").orEmpty(),
        version = optionalString("version")?.toLongOrNull() ?: 1, agents = (array("agents"))?.map { it.jsonPrimitive.content },
        author = optionalString("author") ?: "user", builtIn = optionalString("builtIn") == "true",
        pluginId = plugin?.optionalString("id"), pluginName = plugin?.optionalString("name"),
        pluginEnabled = plugin?.optionalString("enabled") != "false", updatedAt = optionalString("updatedAt")?.toLongOrNull(),
    )
}

/** The skill a save or import response carries. */
internal fun JsonObject.skillSummaryOf() = obj("skill").skillSummary()

internal data class SkillFile(val path: String, val encoding: String, val content: String) {
    val isText get() = encoding == "text"
}

internal fun JsonObject.skillFile() = SkillFile(string("path"), optionalString("encoding") ?: "text", optionalString("content").orEmpty())

internal fun SkillFile.toJson(): JsonObject = buildJsonObject {
    put("path", path)
    put("encoding", encoding)
    put("content", content)
}

internal data class SkillVersion(val version: Long, val author: String, val sessionId: String?, val note: String, val createdAt: Long?)

/** `GET /api/skills/:id[?version=n]`: the skill, the version shown, that version's files (SKILL.md first) and the version list. */
internal data class SkillData(val skill: SkillSummary, val version: Long, val files: List<SkillFile>, val versions: List<SkillVersion>) {
    val current get() = version == skill.version
    val skillMd get() = files.firstOrNull { it.path == "SKILL.md" }
    val others get() = files.filter { it.path != "SKILL.md" }
}

internal fun skillData(body: JsonObject) = SkillData(
    body.obj("skill").skillSummary(),
    body.optionalString("version")?.toLongOrNull() ?: 1,
    body.objects("files").map { it.skillFile() },
    body.objects("versions").map {
        SkillVersion(
            it.optionalString("version")?.toLongOrNull() ?: 0, it.optionalString("author") ?: "user", it.optionalString("sessionId"),
            it.optionalString("note").orEmpty(), it.optionalString("createdAt")?.toLongOrNull(),
        )
    },
)

/** A SKILL.md split into its frontmatter fields and the instructions below. No YAML library: the server parses for real. */
internal data class SkillMd(val fields: List<Pair<String, String>>, val body: String)

private val Frontmatter = Regex("^---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n---[ \\t]*(?:\\r?\\n|$)")
private val FrontmatterLine = Regex("^([A-Za-z][\\w-]*):\\s*(.*)$")

internal fun splitSkillMd(text: String): SkillMd {
    val match = Frontmatter.find(text) ?: return SkillMd(emptyList(), text)
    val fields = mutableListOf<Pair<String, String>>()
    for (line in match.groupValues[1].split(Regex("\\r?\\n"))) {
        val pair = FrontmatterLine.find(line)
        if (pair != null) fields += pair.groupValues[1] to pair.groupValues[2].replace(Regex("^[\"']|[\"']$"), "")
        else if (fields.isNotEmpty() && line.isNotBlank()) fields[fields.lastIndex] = fields.last().let { it.first to "${it.second} ${line.trim()}".trim() }
    }
    return SkillMd(fields, text.substring(match.value.length))
}

private val SkillName = Regex("^[a-z0-9]+(-[a-z0-9]+)*$")

internal fun isSkillName(name: String) = SkillName.matches(name)

/** The SKILL.md a new skill starts from. The description is quoted so any text is valid YAML. */
internal fun newSkillMd(name: String, description: String, body: String): String =
    "---\nname: $name\ndescription: ${JsonPrimitive(description.trim())}\n---\n\n${body.trim()}\n"

internal fun newSkillReady(name: String, description: String, body: String) = isSkillName(name) && description.isNotBlank() && body.isNotBlank()

internal fun newSkillBody(name: String, description: String, body: String): JsonObject = buildJsonObject {
    put("files", buildJsonArray { add(SkillFile("SKILL.md", "text", newSkillMd(name, description, body)).toJson()) })
}

/** The files with SKILL.md replaced by [text]; every other file is kept as it is. */
internal fun withSkillMd(files: List<SkillFile>, text: String): List<SkillFile> =
    files.map { if (it.path == "SKILL.md") it.copy(encoding = "text", content = text) else it }

internal fun editBody(files: List<SkillFile>, text: String): JsonObject = buildJsonObject {
    put("files", JsonArray(withSkillMd(files, text).map { it.toJson() }))
}

internal fun restoreBody(version: Long): JsonObject = buildJsonObject { put("restore", version) }

/** A picked file as an import request: a .zip is sent whole (base64), anything else becomes a one-file skill. */
internal fun importBody(fileName: String, mimeType: String?, bytes: ByteArray): JsonObject {
    val zip = fileName.endsWith(".zip", ignoreCase = true) || mimeType == "application/zip"
    return buildJsonObject {
        if (zip) put("zip", Base64.getEncoder().encodeToString(bytes))
        else put("files", buildJsonArray { add(SkillFile("SKILL.md", "text", bytes.toString(Charsets.UTF_8)).toJson()) })
    }
}

/** Which agents may use a skill, in a few words: null is every agent. */
internal fun agentsLine(ids: List<String>?, agents: List<AgentOption>): UiText {
    if (ids == null) return UiText.Resource(R.string.settings_skills_all_agents)
    val names = agents.filter { it.id in ids }.map { it.name }
    return when {
        names.isEmpty() -> UiText.Resource(R.string.settings_skills_no_agents)
        agents.size > 1 && names.size == agents.size -> UiText.Resource(R.string.settings_skills_all_agents)
        else -> UiText.Literal(names.joinToString(", "))
    }
}

internal data class AgentOption(val id: String, val name: String)

internal fun JsonObject.agentOption() = AgentOption(string("id"), string("name"))

/** The agent allow-list as saved: null for every agent, else the picked ids in the agents' own order. */
internal fun agentsBody(only: Boolean, picked: Set<String>, agents: List<AgentOption>): JsonObject = buildJsonObject {
    if (!only) put("agents", JsonNull)
    else put("agents", buildJsonArray { agents.filter { it.id in picked }.forEach { add(JsonPrimitive(it.id)) } })
}

/** Whether the allow-list on screen differs from the saved one. */
internal fun agentsChanged(saved: List<String>?, only: Boolean, picked: Set<String>): Boolean =
    only != (saved != null) || (only && picked != saved.orEmpty().toSet())
