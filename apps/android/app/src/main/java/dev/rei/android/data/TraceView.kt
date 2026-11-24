package dev.rei.android.data

import dev.rei.android.R
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Reads a recorded provider request or response for people, whatever shape the provider used. A port of the web's
 * `apps/web/src/lib/trace.ts`, so the step detail lays the same things out the same way on both.
 */

private val prettyJson = Json { prettyPrint = true }

/** A JSON value as indented text; a string is shown as it is. */
fun prettyJson(value: JsonElement?): String = when (value) {
    null, JsonNull -> "null"
    is JsonPrimitive -> if (value.isString) value.content else value.toString()
    else -> prettyJson.encodeToString(JsonElement.serializer(), value)
}

data class ContextMessage(
    val role: String,
    val text: String,
    /** Tool calls the message made, as "name(args)". */
    val calls: List<String>,
    /** The message held something that is not text (an image, a file). */
    val other: Int,
    /** A system message sent after the conversation began: a change to a prompt section, shown where it was sent. */
    val update: Boolean = false,
    val reasoning: String = "",
    val encryptedReasoning: Boolean = false,
)

data class OfferedTool(val name: String, val description: String, val schema: JsonElement?)

data class RequestView(
    val system: String?,
    val messages: List<ContextMessage>,
    val tools: List<OfferedTool>,
    /** Nothing recognisable: the Raw tab has the whole thing. */
    val recognised: Boolean,
)

data class ResponseView(val text: String, val reasoning: String, val calls: List<String>, val recognised: Boolean)

data class SectionChange(val name: String, val removed: Boolean, val body: String)

data class SystemSection(val title: String?, val body: String)

private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.arr() = this as? JsonArray
private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private class Content(val text: String, val other: Int, val calls: List<String>, val reasoning: String)

private val NoContent = Content("", 0, emptyList(), "")

private fun callText(name: String, args: JsonElement?): String =
    "$name(${if (args is JsonPrimitive && args.isString) args.content else (args ?: JsonObject(emptyMap())).toString()})"

private fun contentText(c: JsonElement?): Content {
    if (c is JsonPrimitive && c.isString) return Content(c.content, 0, emptyList(), "")
    val list = c.arr() ?: return NoContent
    val text = mutableListOf<String>()
    val calls = mutableListOf<String>()
    val reasoning = mutableListOf<String>()
    var other = 0
    for (part in list) {
        val p = part.obj() ?: continue
        val type = p["type"].str()
        when {
            type == "thinking" && p["thinking"].str() != null -> reasoning += p["thinking"].str()!!
            p["text"].str() != null -> text += p["text"].str()!!
            p["content"].str() != null -> text += p["content"].str()!!
            (type == "tool_use" || type == "toolCall" || type == "function_call") && p["name"].str() != null ->
                calls += callText(p["name"].str()!!, p["input"] ?: p["arguments"])
            type == "tool_result" && p["content"] is JsonArray -> text += contentText(p["content"]).text
            else -> other++
        }
    }
    return Content(text.joinToString("\n"), other, calls, reasoning.joinToString("\n"))
}

/** A Responses reasoning item: its readable text is in `summary`, or in `content` on some gateways. */
private fun reasoningItem(m: JsonObject): ContextMessage {
    val summary = m["summary"].arr()?.mapNotNull { it.obj()?.get("text").str() }.orEmpty().filter(String::isNotEmpty)
    val readable = (summary + contentText(m["content"]).text).filter(String::isNotEmpty).joinToString("\n")
    // Encrypted reasoning cannot be read here; flag it so the UI shows a localized note instead of an empty row.
    return ContextMessage("reasoning", readable, emptyList(), 0, encryptedReasoning = readable.isEmpty() && m["encrypted_content"] != null)
}

private fun oneMessage(m: JsonElement?): ContextMessage? {
    val o = m.obj() ?: return null
    val type = o["type"].str()
    if (type == "reasoning") return reasoningItem(o)
    val role = o["role"].str() ?: type ?: "message"
    val c = contentText(o["content"] ?: o["output"] ?: o["text"])
    val calls = c.calls.toMutableList()
    o["tool_calls"].arr()?.forEach { t ->
        val f = t.obj()?.get("function").obj()
        val name = f?.get("name").str()
        if (f != null && name != null) calls += callText(name, f["arguments"])
    }
    if (type == "function_call" && o["name"].str() != null) calls += callText(o["name"].str()!!, o["arguments"])
    if (type == "function_call_output" && o["output"].str() != null) return ContextMessage("tool", o["output"].str()!!, calls, c.other)
    return ContextMessage(if (o["role"].str() == "tool") "tool" else role, c.text, calls, c.other, reasoning = c.reasoning)
}

/** The request as sent, read for people: system prompt, messages in order, tool definitions. */
fun describeRequest(request: JsonElement?): RequestView {
    val req = request.obj() ?: return RequestView(null, emptyList(), emptyList(), false)
    var system: String? = when {
        req["system"].str() != null -> req["system"].str()
        req["system"] is JsonArray -> contentText(req["system"]).text
        req["instructions"].str() != null -> req["instructions"].str()
        else -> null
    }
    val list: List<JsonElement> = when {
        req["messages"] is JsonArray -> req["messages"].arr()!!
        req["input"] is JsonArray -> req["input"].arr()!!
        req["input"].str() != null -> listOf(JsonObject(mapOf("role" to JsonPrimitive("user"), "content" to JsonPrimitive(req["input"].str()!!))))
        else -> emptyList()
    }
    val messages = mutableListOf<ContextMessage>()
    for (m in list) {
        val cm = oneMessage(m) ?: continue
        val isSystem = cm.role == "system" || cm.role == "developer"
        // Only system messages ahead of the conversation are the prompt; later ones are updates and stay where they were sent.
        when {
            isSystem && messages.isEmpty() -> system = if (system == null) cm.text else "$system\n\n${cm.text}"
            isSystem -> messages += cm.copy(role = "system", update = true)
            else -> messages += cm
        }
    }
    val tools = req["tools"].arr().orEmpty().mapNotNull { t ->
        val o = t.obj() ?: return@mapNotNull null
        val f = o["function"].obj() ?: o
        val name = f["name"].str() ?: return@mapNotNull null
        OfferedTool(name, f["description"].str().orEmpty(), f["parameters"] ?: f["input_schema"] ?: f["schema"])
    }
    return RequestView(system, messages, tools, system != null || messages.isNotEmpty() || tools.isNotEmpty())
}

/** The model's answer as text, reasoning and tool calls; an SSE stream (a string) is shown as written. */
fun describeResponse(response: JsonElement?): ResponseView {
    if (response is JsonPrimitive && response.isString) return ResponseView(response.content, "", emptyList(), true)
    val res = response.obj() ?: return ResponseView("", "", emptyList(), false)
    val texts = mutableListOf<String>()
    val reasoning = mutableListOf<String>()
    val calls = mutableListOf<String>()
    fun take(m: JsonElement?) {
        val cm = oneMessage(m) ?: return
        if (cm.role == "reasoning") {
            if (cm.text.isNotEmpty()) reasoning += cm.text
            return
        }
        if (cm.text.isNotEmpty()) texts += cm.text
        if (cm.reasoning.isNotEmpty()) reasoning += cm.reasoning
        calls += cm.calls
    }
    res["choices"].arr()?.forEach { take(it.obj()?.get("message")) }
    if (res["content"] is JsonArray) take(JsonObject(mapOf("role" to JsonPrimitive("assistant"), "content" to res["content"]!!)))
    // Output items carry the reasoning too, so they are read even when `output_text` gives the answer.
    res["output"].arr()?.forEach { take(it) }
    if (res["output_text"].str() != null && texts.isEmpty()) texts += res["output_text"].str()!!
    if (res["message"] is JsonObject) take(res["message"])
    if (res["text"].str() != null && texts.isEmpty()) texts += res["text"].str()!!
    return ResponseView(
        texts.joinToString("\n\n"),
        reasoning.joinToString("\n\n"),
        calls,
        texts.isNotEmpty() || calls.isNotEmpty() || reasoning.isNotEmpty(),
    )
}

private val Change = Regex("""^(Updated|Removed) system prompt section "([^"]+)"(?::\n\n|\.)""")
private val NextChange = Regex("""\n\n(?:Updated|Removed) system prompt section "[^"]+"(?::\n\n|\.)""")

/**
 * A later system message is framed as `Updated system prompt section "x":\n\n<text>` or `Removed system prompt section "x".`
 * (several can share one message). Text that does not start that way comes back as one unnamed change.
 */
fun sectionChanges(text: String): List<SectionChange> {
    val out = mutableListOf<SectionChange>()
    var rest = text.trim()
    while (rest.isNotEmpty()) {
        val m = Change.find(rest)
        if (m == null) {
            out += SectionChange("", false, rest)
            break
        }
        val removed = m.groupValues[1] == "Removed"
        val after = rest.substring(m.value.length)
        val next = NextChange.find(after)
        val body = if (removed) "" else (if (next != null) after.substring(0, next.range.first) else after).trim()
        out += SectionChange(m.groupValues[2], removed, body)
        rest = (if (removed) after else if (next != null) after.substring(next.range.first) else "").trim()
    }
    return out
}

private val TaggedSection = Regex("""(?m)^<([A-Za-z_][\w-]*)>[ \t]*\n?([\s\S]*?)\n?</\1>[ \t]*$""")
private val Heading = Regex("""^#{1,3}\s+(.+?)\s*$""")

/**
 * Splits a long system prompt into its sections: `<name>...</name>` blocks (how prompt sections are tagged), else
 * markdown headings. A prompt with neither comes back as one untitled section.
 */
fun systemSections(text: String): List<SystemSection> {
    val tagged = mutableListOf<SystemSection>()
    var last = 0
    for (m in TaggedSection.findAll(text)) {
        val before = text.substring(last, m.range.first).trim()
        if (before.isNotEmpty()) tagged += SystemSection(null, before)
        tagged += SystemSection(m.groupValues[1], m.groupValues[2].trim())
        last = m.range.last + 1
    }
    if (tagged.isNotEmpty()) {
        val rest = text.substring(last).trim()
        if (rest.isNotEmpty()) tagged += SystemSection(null, rest)
        return tagged
    }
    val titles = mutableListOf<String?>(null)
    val lines = mutableListOf(mutableListOf<String>())
    var fenced = false
    for (line in text.split("\n")) {
        if (line.startsWith("```") || line.startsWith("~~~")) fenced = !fenced
        val h = if (fenced) null else Heading.find(line)
        if (h != null) {
            titles += h.groupValues[1]
            lines += mutableListOf<String>()
        } else {
            lines.last() += line
        }
    }
    return titles.indices
        .map { SystemSection(titles[it], lines[it].joinToString("\n").trim()) }
        .filter { it.title != null || it.body.isNotEmpty() }
}

/** Friendly labels for app-owned sections; unknown headings and historical untagged text stay readable. */
fun promptSectionLabel(name: String): String = when (name) {
    "instructions" -> "Agent instructions"
    "clock" -> "Date and time"
    "session_role" -> "Session role"
    "delegation" -> "Delegation"
    "sessions" -> "Worker sessions"
    "sandbox" -> "Sandbox"
    "browser" -> "Browser"
    "web" -> "Web"
    "connectors" -> "Connectors"
    "approvals" -> "Approvals"
    "skills" -> "Skills"
    "skill_saving" -> "Saving skills"
    "memory" -> "Memory"
    "profile" -> "Profile"
    "recent" -> "Recent history"
    "components" -> "Response components"
    "triggers" -> "Triggers"
    "trigger_run" -> "Trigger run"
    "tool_activity" -> "Tool activity"
    "untrusted_content" -> "Untrusted content"
    else -> name
}

/** A tool call's action class in words, as the web's policy labels it. */
fun actionClassLabel(actionClass: String?): UiText = when (actionClass) {
    "read_internal" -> UiText.Resource(R.string.chat_trace_class_read_internal)
    "read_external" -> UiText.Resource(R.string.chat_trace_class_read_external)
    "write_internal" -> UiText.Resource(R.string.chat_trace_class_write_internal)
    "write_external" -> UiText.Resource(R.string.chat_trace_class_write_external)
    "send" -> UiText.Resource(R.string.chat_trace_class_send)
    "irreversible" -> UiText.Resource(R.string.chat_trace_class_irreversible)
    "credentials" -> UiText.Resource(R.string.chat_trace_class_credentials)
    "memory_write" -> UiText.Resource(R.string.chat_trace_class_memory_write)
    "configure" -> UiText.Resource(R.string.chat_trace_class_configure)
    else -> UiText.Literal(actionClass.orEmpty())
}

/** What the policy decided, in the web's words. */
fun decisionLabel(decision: String?): UiText = when (decision) {
    "allow" -> UiText.Resource(R.string.chat_trace_decision_allow)
    "granted" -> UiText.Resource(R.string.chat_trace_decision_granted)
    "ask" -> UiText.Resource(R.string.chat_trace_decision_ask)
    "deny" -> UiText.Resource(R.string.chat_trace_decision_deny)
    else -> UiText.Literal("–")
}

/** "13,584": thousands separated, as the web shows token counts. */
fun groupedNumber(value: Long): String = java.text.NumberFormat.getIntegerInstance().format(value)

/** An untagged section is named by its first words. */
fun sectionOpening(body: String): UiText {
    val line = body.lineSequence().first().trim()
    return when {
        line.length > 48 -> UiText.Literal(line.take(47).trimEnd() + "…")
        line.isEmpty() -> UiText.Resource(R.string.chat_trace_untitled)
        else -> UiText.Literal(line)
    }
}

/** The strings of a JSON array, for lists of names. */
fun JsonElement?.strings(): List<String> = this.arr().orEmpty().mapNotNull { it.str() }

internal fun JsonElement?.number(): Long? = (this as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toLong()
