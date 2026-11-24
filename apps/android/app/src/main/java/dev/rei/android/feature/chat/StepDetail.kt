package dev.rei.android.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import dev.rei.android.ui.components.chat.ImageViewer
import dev.rei.android.ui.components.markdown.loadStepImage
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rei.android.data.ContextMessage
import dev.rei.android.data.ReiApi
import dev.rei.android.data.TraceStep
import dev.rei.android.data.actionClassLabel
import dev.rei.android.data.decisionLabel
import dev.rei.android.data.describeRequest
import dev.rei.android.data.describeResponse
import dev.rei.android.data.groupedNumber
import dev.rei.android.data.number
import dev.rei.android.data.prettyJson
import dev.rei.android.data.promptSectionLabel
import dev.rei.android.data.sectionChanges
import dev.rei.android.data.sectionOpening
import dev.rei.android.data.stepDetail
import dev.rei.android.data.strings
import dev.rei.android.data.systemSections
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.copyToClipboard
import dev.rei.android.ui.components.chat.activityIcon
import dev.rei.android.ui.components.chat.activityLabel
import dev.rei.android.ui.components.chat.activityStatus
import dev.rei.android.ui.components.chat.duration
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.mono
import dev.rei.android.ui.theme.tabular
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.text.DateFormat
import java.util.Date
import java.util.Locale

private enum class LlmTab(val label: String) { Context("Context"), Response("Response"), Raw("Raw"), Stats("Stats") }

private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.contentOrNull
private fun JsonElement?.flag(): Boolean = (this as? JsonPrimitive)?.booleanOrNull == true

/**
 * One step in full, laid out as the web's Inspector does: for a model call the tabs Context, Response, Raw and Stats; for a
 * tool call the policy's decision, input and output; for a capability change what came and went.
 */
@Composable
fun StepDetail(
    api: ReiApi,
    step: TraceStep,
    onBack: () -> Unit,
    onOpenStep: (String) -> Unit,
    /** Scrolls the chat to this approval's message; null when that message is not loaded. */
    onOpenApproval: (() -> Unit)? = null,
) {
    var payload by remember(step.id) { mutableStateOf<JsonObject?>(null) }
    var error by remember(step.id) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(step.id) { mutableStateOf(LlmTab.Context) }
    LaunchedEffect(step.id, step.status) {
        try {
            payload = api.stepDetail(step.id)
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            error = failure.message ?: "Couldn’t load this step."
        }
    }
    val data = payload
    val llm = data?.get("llm").obj()
    val truncated = data?.get("truncated").flag()
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            ReiIconButton(ReiIcons.Back, "Back to steps", onBack, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(activityIcon(step), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                activityLabel(step),
                Modifier.padding(start = 4.dp),
                style = MaterialTheme.typography.titleSmall,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        error?.let { Note(it, error = true) }
        llm?.get("error").obj()?.get("message").text()?.let { Note(it, error = true) }
        if (data == null && error == null) {
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) {
                CircularProgressIndicator(Modifier.size(24.dp))
            }
        }
        when {
            step.type == "llm.call" -> {
                PrimaryTabRow(selectedTabIndex = tab.ordinal, containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
                    LlmTab.entries.forEach { entry ->
                        Tab(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            text = { Text(entry.label, style = MaterialTheme.typography.labelLarge) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
                when {
                    tab == LlmTab.Stats -> Stats(step, data)
                    llm == null -> Unit
                    tab == LlmTab.Context -> {
                        llm["tools"].obj()?.let { OfferedTools(it, onOpenStep) }
                        ContextView(llm["request"], truncated)
                    }
                    tab == LlmTab.Response -> ResponseView(llm["response"])
                    else -> {
                        if (truncated) Note("Some long text was cut to 200,000 characters.")
                        JsonView("Raw", llm)
                    }
                }
            }
            step.type == "capabilities.changed" -> ChangeDetail(step, data?.get("change").obj())
            else -> ToolDetail(api, step, data, onOpenApproval)
        }
    }
}

// ---- model call ---------------------------------------------------------------------------------------------------

@Composable
private fun ContextView(request: JsonElement?, truncated: Boolean) {
    val view = describeRequest(request)
    if (!view.recognised) {
        Quiet("This request has a shape the inspector can’t lay out. The Raw tab shows it as recorded.")
        return
    }
    val sections = view.system?.let(::systemSections).orEmpty()
    val updates = view.messages.count { it.update }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (truncated) Note("Some long text was cut to 200,000 characters.")
        view.system?.let { system ->
            Column {
                SectionLabel("System prompt" + if (sections.size > 1) " · ${sections.size} sections" else "")
                if (sections.size > 1) {
                    sections.forEach { s ->
                        Collapsible({ Text(s.title?.let(::promptSectionLabel) ?: sectionOpening(s.body), fontWeight = FontWeight.Medium) }) { LongText(s.body) }
                    }
                } else {
                    Collapsible({ Text("System prompt", fontWeight = FontWeight.Medium) }, initiallyOpen = true) { LongText(system) }
                }
            }
        }
        Column {
            SectionLabel(
                "Messages · ${view.messages.size}" +
                    if (updates > 0) " ($updates prompt update${if (updates == 1) "" else "s"}, in the order sent)" else "",
            )
            view.messages.forEach { MessageItem(it) }
        }
        if (view.tools.isNotEmpty()) {
            Column {
                SectionLabel("Tools · ${view.tools.size}")
                view.tools.forEach { t ->
                    Collapsible({ Text(t.name, style = MaterialTheme.typography.bodyMedium.mono(), maxLines = 1, overflow = TextOverflow.Ellipsis) }) {
                        if (t.description.isNotEmpty()) LongText(t.description)
                        t.schema?.let { LongText(prettyJson(it), mono = true) }
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageItem(m: ContextMessage) {
    if (m.update) {
        val changes = sectionChanges(m.text)
        val peek = changes.joinToString(" · ") { if (it.name.isNotEmpty()) "${if (it.removed) "removed" else "updated"} ${it.name}" else "system message" }
        Collapsible({ RolePill("prompt update"); Peek(peek) }) {
            changes.forEach { c ->
                if (c.name.isNotEmpty()) Note(if (c.removed) "Section “${c.name}” was taken out of the prompt." else "Section “${c.name}” replaced by:")
                if (c.body.isNotEmpty()) LongText(c.body)
            }
        }
        return
    }
    val peek = m.text.ifEmpty { m.calls.firstOrNull() ?: if (m.other > 0) "${m.other} attachment${if (m.other == 1) "" else "s"}" else "" }
    Collapsible({ RolePill(m.role); Peek(peek.replace(Regex("\\s+"), " ").take(90)) }) {
        if (m.reasoning.isNotEmpty()) {
            Note("Reasoning")
            LongText(m.reasoning)
        }
        if (m.text.isNotEmpty()) LongText(m.text)
        m.calls.forEach { LongText("→ $it", mono = true) }
        if (m.other > 0) Note("${m.other} attachment${if (m.other == 1) "" else "s"} not shown here (see Raw).")
    }
}

@Composable
private fun ResponseView(response: JsonElement?) {
    val view = describeResponse(response)
    if (!view.recognised) {
        Quiet("No readable answer was recorded. The Raw tab shows what was.")
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (view.reasoning.isNotEmpty()) {
            Column {
                SectionLabel("Reasoning")
                LongText(view.reasoning)
            }
        }
        if (view.text.isNotEmpty()) LongText(view.text)
        if (view.calls.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel("Tool calls")
                view.calls.forEach { LongText(it, mono = true) }
            }
        }
    }
}

@Composable
private fun Stats(step: TraceStep, data: JsonObject?) {
    val summary = data?.get("step").obj()
    val tokens = summary?.get("tokens").obj()
    fun num(key: String) = tokens?.get(key).number()?.let(::groupedNumber) ?: "–"
    val prefix = summary?.get("prefix").obj()
    val rows = buildList {
        add("Model" to (summary?.get("model").text() ?: step.model ?: "–"))
        add("Provider" to (summary?.get("providerName").text() ?: "–"))
        add("Status" to activityStatus(step) + (step.errorCode?.let { " ($it)" } ?: ""))
        add("Started" to formatWhen(step.startedAt))
        add("Input tokens" to num("input"))
        add("Output tokens" to num("output"))
        add("Cached tokens" to num("cached"))
        if (prefix != null) {
            val matched = prefix["matched"].number()
            add("Same start as last call" to if (matched == null) "First call" else "$matched of ${prefix["items"].number() ?: 0} items")
        }
        add("Reasoning tokens" to num("reasoning"))
        add("Total tokens" to num("total"))
        add("First byte" to (summary?.get("firstByteMs").number()?.let { duration(it) } ?: "–"))
        add("Latency" to duration(step.latencyMs))
        data?.get("payloadBytes").number()?.let { add("Recorded size" to "${groupedNumber(it)} bytes" + if (data?.get("truncated").flag()) " (cut)" else "") }
    }
    Facts(rows)
}

/** The tools a model call was offered and what changed since the previous call. */
@Composable
private fun OfferedTools(tools: JsonObject, onOpenStep: (String) -> Unit) {
    val offered = tools["offered"].strings()
    val added = (tools["added"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val removed = tools["removed"].strings()
    Column {
        SectionLabel("Offered tools · ${offered.size}")
        when {
            tools["previousStepId"].text() == null -> Note("The first model call of this chat: its core tools.")
            added.isEmpty() && removed.isEmpty() -> Note("The same tools as the previous model call.")
            else -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                added.forEach { a ->
                    val loadedBy = a["loadedBy"].text()
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("+", style = MaterialTheme.typography.bodyMedium)
                        Column {
                            Text(a["name"].text().orEmpty(), style = MaterialTheme.typography.bodySmall.mono())
                            if (loadedBy != null) {
                                val why = a["reason"].text()?.let(::loadReason)?.let { r -> " ($r${a["group"].text()?.let { g -> ": $g" } ?: ""})" }.orEmpty()
                                Text(
                                    "loaded by a search$why",
                                    Modifier.clickable(role = Role.Button) { onOpenStep(loadedBy) },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            } else {
                                Text("offered again or added by a capability change", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                removed.forEach { name ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("−", style = MaterialTheme.typography.bodyMedium)
                        Column {
                            Text(name, style = MaterialTheme.typography.bodySmall.mono())
                            Text("no longer offered", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        Collapsible({ Text("All offered tools", fontWeight = FontWeight.Medium) }) {
            Text(offered.joinToString(", "), Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall.mono())
        }
    }
}

private fun loadReason(reason: String) = when (reason) {
    "group" -> "its group matched"
    "ranked" -> "ranked for the query"
    "load" -> "named in load"
    else -> reason
}

// ---- tool call ----------------------------------------------------------------------------------------------------

@Composable
private fun ToolDetail(api: ReiApi, step: TraceStep, data: JsonObject?, onOpenApproval: (() -> Unit)?) {
    val summary = data?.get("step").obj()
    val tool = data?.get("tool").obj()
    val actionClass = summary?.get("actionClass").text()
    val decision = step.decision?.let(::decisionLabel) ?: "–"
    Facts(
        buildList {
            add("Tool" to (step.toolName ?: "–"))
            add("Class" to actionClassLabel(actionClass).ifEmpty { "–" })
            add("Decision" to decision + if (step.approvalId != null && onOpenApproval == null) " · approval" else "")
            add("Status" to activityStatus(step))
            step.summary?.let { add("Summary" to it) }
            add("Started" to formatWhen(step.startedAt))
            add("Time" to duration(step.latencyMs))
            if (step.sideEffect) add("Effect" to "Acted outside the box")
        },
        links = if (step.approvalId != null && onOpenApproval != null) mapOf("Decision" to FactLink("See the approval", onOpenApproval)) else emptyMap(),
    )
    if (tool == null) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (data?.get("truncated").flag()) Note("Some long text was cut to 200,000 characters.")
        if (tool["isError"].flag()) Note("The tool reported an error.", error = true)
        tool["discovery"].obj()?.let { Discovery(it) }
        tool["fetch"].obj()?.let { WebFetch(it) }
        JsonView("Input", tool["input"])
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel("Output")
            val output = (tool["output"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
            if (output.isEmpty()) Quiet("No output.")
            output.forEach { part ->
                if (part["type"].text() == "text") LongText(part["text"].text().orEmpty())
                else StepImage(api, step.id, (part["index"].number() ?: 0).toInt(), "Image ${(part["index"].number() ?: 0) + 1} from ${step.toolName ?: "the tool"}")
            }
        }
    }
}

private val CacheLabel = mapOf("hit" to "Stored copy (no network)", "miss" to "Fetched (nothing stored)", "refresh" to "Fetched again (refresh)")
private val ModeLabel = mapOf(
    "overview" to "Outline and opening",
    "whole" to "Whole page",
    "query" to "Passages matching the query",
    "section" to "One section",
    "offset" to "Text from an offset",
)

private fun renderSummary(r: JsonObject): String {
    when (r["skipped"].text()) {
        "off" -> return "Not rendered: disabled by the reader request"
        "unavailable" -> return "Not rendered: the page reader has no browser"
    }
    if (r["failed"].flag()) return "The render failed; the page as fetched was used"
    val parts = mutableListOf(
        when (r["reason"].text()) {
            "forced" -> "Forced (dev diagnostic)"
            "low_quality" -> "Only the page’s summary could be read without JavaScript"
            else -> "Page needs JavaScript"
        },
    )
    r["ended"].text()?.let { parts += if (it == "stable") "read once the text settled" else "read at the deadline" }
    if (r["truncated"].flag()) parts += "HTML cut at 5 MiB"
    return parts.joinToString(", ")
}

/** How a web_fetch got its page and what it showed the model. */
@Composable
private fun WebFetch(d: JsonObject) {
    fun num(key: String) = d[key].number()?.let(::groupedNumber)
    val render = d["render"].obj()
    Column {
        SectionLabel("Fetch")
        Facts(
            buildList {
                add("Host" to d["host"].text().orEmpty())
                d["title"].text()?.let { add("Title" to it) }
                add("Source" to (CacheLabel[d["cache"].text()] ?: "–"))
                add("Method" to if (d["method"].text() == "render") "Rendered in the browser" else "HTTP")
                render?.let { r ->
                    add("Rendering" to renderSummary(r))
                    r["queueMs"].number()?.takeIf { it > 0 }?.let { add("Waited for the browser" to duration(it)) }
                    r["engine"].text()?.let { engine ->
                        val version = r["engineVersion"].text()?.let { " $it" }.orEmpty()
                        val fallback = r["fallback"].obj()?.let { " (fallback after ${it["from"].text()}: ${it["reason"].text()})" }.orEmpty()
                        add("Render engine" to "$engine$version$fallback")
                    }
                    r["renderMs"].number()?.let { add("Render time" to duration(it)) }
                    r["connections"].number()?.let { c -> add("Render connections" to groupedNumber(c) + (r["refused"].number()?.takeIf { it > 0 }?.let { ", ${groupedNumber(it)} refused" } ?: "")) }
                    r["blockedMedia"].number()?.takeIf { it > 0 }?.let { add("Media not loaded" to groupedNumber(it)) }
                }
                d["mode"].text()?.let { add("Shown" to (ModeLabel[it] ?: it)) }
                d["sections"].strings().takeIf { it.isNotEmpty() }?.let { add("Sections" to it.joinToString(", ")) }
                d["status"].number()?.let { add("HTTP status" to it.toString()) }
                d["redirects"].number()?.let { add("Redirects" to it.toString()) }
                d["mediaType"].text()?.let { add("Media type" to it) }
                num("bytes")?.let { add("Downloaded" to "$it bytes") }
                d["extractor"].text()?.let { add("Extractor" to it) }
                d["quality"].text()?.let { add("Quality" to it) }
                num("tokensReturned")?.let { add("Tokens returned" to it) }
                num("pageTokens")?.let { add("Tokens on the page" to it) }
                add("Duration" to duration(d["durationMs"].number()))
            },
        )
    }
}

/** What a search_capabilities call searched, ranked, loaded and suggested. */
@Composable
private fun Discovery(d: JsonObject) {
    val loaded = (d["loaded"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val candidates = (d["candidates"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val directory = d["directory"].obj()
    Column {
        SectionLabel("Discovery")
        Facts(
            buildList {
                d["query"].text()?.takeIf { it.isNotEmpty() }?.let { add("Query" to "“$it”") }
                directory?.let {
                    val tools = it["tools"].number() ?: 0
                    add("Directory" to "${it["connectorName"].text()}: $tools tool${if (tools == 1L) "" else "s"} listed, none loaded")
                }
                add(
                    "Loaded" to if (loaded.isEmpty()) "Nothing" else loaded.joinToString("\n") { l ->
                        l["name"].text().orEmpty() + " · " + loadReason(l["reason"].text().orEmpty()) + (l["group"].text()?.let { " ($it)" } ?: "")
                    },
                )
                names("Already loaded", d["alreadyLoaded"].strings())?.let(::add)
                names("Also relevant", d["alsoRelevant"].strings())?.let(::add)
                names("Skills", d["skills"].strings())?.let(::add)
                names("Not found", d["notFound"].strings())?.let(::add)
            },
        )
        if (candidates.isNotEmpty()) {
            Collapsible({ Text("Ranked candidates · ${candidates.size}", fontWeight = FontWeight.Medium) }) {
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    candidates.forEach { c ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                            Text(c["name"].text().orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.mono())
                            Text(c["kind"].text().orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                "${Math.round((c["coverage"].text()?.toDoubleOrNull() ?: 0.0) * 100)}% · ${c["score"].text().orEmpty()}",
                                style = MaterialTheme.typography.bodySmall.tabular(),
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun names(label: String, names: List<String>): Pair<String, String>? = if (names.isEmpty()) null else label to names.joinToString(", ")

/** Connector tools that came, went or changed in the open conversation while the run went on. */
@Composable
private fun ChangeDetail(step: TraceStep, change: JsonObject?) {
    Facts(
        buildList {
            change?.let { add("Connectors" to it["connectors"].strings().joinToString(", ")) }
            add("Seen" to formatWhen(step.startedAt))
        },
    )
    if (change != null) {
        Facts(
            listOfNotNull(
                names("Added", change["added"].strings()),
                names("Removed", change["removed"].strings()),
                names("Changed", change["changed"].strings()),
            ),
        )
    }
}

// ---- building blocks ----------------------------------------------------------------------------------------------

/** A tappable word after a fact's value, such as "See the approval". */
internal class FactLink(val text: String, val onClick: () -> Unit)

/** An image a tool returned, shown in the sheet and full screen on tap. */
@Composable
private fun StepImage(api: ReiApi, stepId: String, index: Int, description: String) {
    val loaded by produceState<Pair<Boolean, ImageBitmap?>>(false to null, stepId, index) { value = true to loadStepImage(api, stepId, index, 1200) }
    var viewing by remember { mutableStateOf(false) }
    val image = loaded.second
    when {
        image != null -> Image(
            image,
            contentDescription = description,
            Modifier
                .fillMaxWidth()
                .clip(ReiShapes.Inset)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, ReiShapes.Inset)
                .clickable(onClickLabel = "View full screen", role = Role.Button) { viewing = true },
            contentScale = ContentScale.FillWidth,
        )
        loaded.first -> Note("$description can’t be shown.")
        else -> Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
    }
    if (viewing) ImageViewer(description, onDismiss = { viewing = false }, key = stepId to index) { loadStepImage(api, stepId, index, 2400) }
}

/** Label and value pairs in two columns: the label fixed-width and quiet, the value free to wrap. */
@Composable
internal fun Facts(rows: List<Pair<String, String>>, modifier: Modifier = Modifier, links: Map<String, FactLink> = emptyMap()) {
    if (rows.isEmpty()) return
    SelectionContainer {
        Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            rows.forEach { (label, value) ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(label, Modifier.width(112.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val link = links[label]
                    if (link == null) {
                        Text(value, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium.tabular())
                    } else {
                        val linkStyle = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary, textDecoration = TextDecoration.Underline))
                        Text(
                            buildAnnotatedString {
                                append("$value · ")
                                withLink(LinkAnnotation.Clickable("fact", linkStyle) { link.onClick() }) { append(link.text) }
                            },
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium.tabular(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun SectionLabel(text: String) {
    Text(
        text,
        Modifier.padding(top = 6.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun Quiet(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun Note(text: String, error: Boolean = false) {
    if (error) {
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f), ReiShapes.Inset).padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(ReiIcons.Alert, null, Modifier.padding(top = 2.dp).size(16.dp), tint = MaterialTheme.colorScheme.error)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }
    } else {
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun RolePill(text: String) {
    Text(
        text.uppercase(Locale.ROOT),
        Modifier.background(MaterialTheme.colorScheme.surfaceContainerHighest, ReiShapes.Pill).padding(horizontal = 8.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
    )
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Peek(text: String) {
    Text(
        text,
        Modifier.weight(1f),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A bordered block with a summary row that opens to its content, as the web's `<details>` items. */
@Composable
private fun Collapsible(
    summary: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
    initiallyOpen: Boolean = false,
    content: @Composable () -> Unit,
) {
    var open by rememberSaveable { mutableStateOf(initiallyOpen) }
    Surface(
        Modifier.padding(top = 6.dp).fillMaxWidth(),
        shape = ReiShapes.Inset,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .clickable(onClickLabel = if (open) "Collapse" else "Expand", role = Role.Button) { open = !open }
                    .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), content = summary)
                Icon(
                    ReiIcons.Down,
                    null,
                    Modifier.size(16.dp).rotate(if (open) 0f else -90f),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (open) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
            }
        }
    }
}

private const val LongTextLimit = 4000

/** Recorded text in a muted box, cut with "Show more" so a 200,000-character prompt does not stall the sheet. */
@Composable
private fun LongText(text: String, mono: Boolean = false) {
    var all by rememberSaveable(text.length, text.hashCode()) { mutableStateOf(false) }
    val cut = !all && text.length > LongTextLimit
    Column {
        SelectionContainer {
            Text(
                if (cut) text.take(LongTextLimit) else text,
                Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer, ReiShapes.Inset).padding(horizontal = 12.dp, vertical = 10.dp),
                style = (if (mono) MaterialTheme.typography.bodySmall.mono() else MaterialTheme.typography.bodySmall).copy(lineHeight = 18.sp),
            )
        }
        if (text.length > LongTextLimit) {
            TextButton(onClick = { all = !all }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(
                    if (all) "Show less" else "Show more (${groupedNumber((text.length - LongTextLimit).toLong())} more characters)",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** A JSON value pretty-printed with a copy button. */
@Composable
private fun JsonView(label: String, value: JsonElement?) {
    val context = LocalContext.current
    val text = remember(value) { prettyJson(value) }
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ReiIconButton(ReiIcons.Copy, "Copy ${label.lowercase(Locale.ROOT)}", { copyToClipboard(context, label, text) }, tint = MaterialTheme.colorScheme.onSurfaceVariant, iconSize = 16.dp)
        }
        LongText(text, mono = true)
    }
}

/** "3:42 PM" today, "Nov 20, 3:42 PM" on another day, with the year when it is not this one. */
internal fun formatWhen(ts: Long, now: Long = System.currentTimeMillis()): String {
    val locale = Locale.getDefault()
    val time = DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(Date(ts))
    val calendar = java.util.Calendar.getInstance()
    calendar.timeInMillis = ts
    val today = java.util.Calendar.getInstance().apply { timeInMillis = now }
    if (calendar.get(java.util.Calendar.YEAR) == today.get(java.util.Calendar.YEAR) && calendar.get(java.util.Calendar.DAY_OF_YEAR) == today.get(java.util.Calendar.DAY_OF_YEAR)) return time
    val pattern = if (calendar.get(java.util.Calendar.YEAR) == today.get(java.util.Calendar.YEAR)) "MMM d" else "MMM d, yyyy"
    return java.text.SimpleDateFormat(pattern, locale).format(Date(ts)) + ", " + time
}
