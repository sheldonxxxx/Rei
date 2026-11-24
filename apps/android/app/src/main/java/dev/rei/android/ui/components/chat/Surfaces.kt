package dev.rei.android.ui.components.chat

import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.ui.components.markdown.MarkdownPicture
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.components.markdown.isExternalMarkdownLink
import dev.rei.android.ui.components.markdown.openExternalLink
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Surface
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val prettyJson = Json { prettyPrint = true }

private class SurfaceEngine(
    val api: ReiApi,
    val id: String,
    val revision: Int,
    val sessionId: String,
    val interactive: Boolean,
    initial: JsonObject,
) {
    var data by mutableStateOf(initial)
    var failure by mutableStateOf<String?>(null)
    var sending by mutableStateOf(false)
    var sent by mutableStateOf<String?>(null)

    suspend fun send(source: JsonObject, scope: String) {
        val event = (source["action"] as? JsonObject)?.get("event") as? JsonObject ?: return
        val name = event.optionalString("name") ?: return
        val sourceId = source.optionalString("id") ?: return
        val resolved = (event["context"] as? JsonObject)?.mapValues { (_, value) ->
            surfaceValue(value, data, "")
        }.orEmpty()
        val context = JsonObject(resolved.filterValues { it != null }.mapValues { it.value!! })
        val request = buildJsonObject {
            put("requestId", UUID.randomUUID().toString())
            put("revision", revision)
            put("dataModel", data)
            put("action", buildJsonObject {
                put("version", "1.0")
                put("action", buildJsonObject {
                    put("name", name)
                    put("surfaceId", id)
                    put("sourceComponentId", sourceId)
                    put("timestamp", Instant.now().toString())
                    put("context", context)
                    surfaceValue(event["userMessage"], data, scope).text().takeIf { it.isNotBlank() }
                        ?.let { put("userMessage", it) }
                })
            })
        }
        api.request("POST", listOf("api", "sessions", sessionId, "surfaces", id, "actions"), request)
        sent = sourceId
    }

    fun input(target: String, value: JsonElement) {
        data = pointerSet(data, target, value) as? JsonObject ?: data
    }
}

@Composable
fun InlineSurface(api: ReiApi, currentSessionId: String, value: JsonObject, detail: Boolean = false) {
    val id = value.optionalString("surfaceId") ?: return
    val state = value.optionalString("state").orEmpty()
    val owner = value.optionalString("sessionId") ?: currentSessionId
    val title = value.optionalString("title").orEmpty()
    val revision = value.optionalString("revision")?.toIntOrNull() ?: 0
    val create = (value["message"] as? JsonObject)?.get("createSurface") as? JsonObject
    val supported = create?.optionalString("catalogId") == "rei/catalog/1" && value.optionalString("protocolVersion") == "1.0"
    val components = remember(create) { create?.objects("components").orEmpty().associateBy { it.optionalString("id").orEmpty() } }
    var inspect by remember(id) { mutableStateOf(false) }
    val engine = remember(api, currentSessionId, id, revision) {
        SurfaceEngine(
            api, id, revision, owner,
            owner == currentSessionId && state in setOf("live", "idle"),
            (create?.get("dataModel") as? JsonObject) ?: JsonObject(emptyMap()),
        )
    }
    val drawable = supported && state != "removed" && "root" in components
    // Everything that reads the surface's JSON runs here, outside Compose, so a surface Rei's checks let through
    // but this renderer cannot handle shows its fallback text instead of taking the app down.
    val spec = remember(drawable, components, engine.data) {
        if (!drawable) null else runCatching { resolveSurface(components, engine.data) }
            .onFailure { Log.w("Surfaces", "Surface $id revision $revision could not be drawn", it) }
    }
    val fallback = value.optionalString("fallback").orEmpty()
    Surface(
        Modifier.fillMaxWidth(),
        shape = ReiShapes.Card,
        color = ReiTheme.colors.card,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(start = 14.dp, end = 4.dp, top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.padding(end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    if (title.isNotBlank()) Text(title, style = MaterialTheme.typography.titleMedium)
                    when (state) {
                        "live" -> Text("Live", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        "removed" -> Text("Removed", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        "frozen" -> Text("Copy", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Column(Modifier.padding(end = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val resolved = spec?.getOrNull()
                when {
                    resolved != null -> {
                        SurfaceView(engine, resolved)
                        if (components.values.any { it.optionalString("component") !in surfaceTypes }) Text(fallback)
                    }
                    spec != null -> {
                        if (fallback.isNotBlank()) Text(fallback)
                        Text(
                            "This surface couldn't be drawn here. Inspect it for details.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    else -> Text(fallback)
                }
                engine.failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            if (detail) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    ReiIconButton(ReiIcons.Info, "Inspect surface", { inspect = true })
                }
            }
        }
    }
    if (inspect) SurfaceInspector(api, owner, id, title) { inspect = false }
}

private val surfaceTypes = setOf(
    "Column", "Row", "List", "Card", "Text", "Divider", "Image", "Icon", "Button", "TextField", "CheckBox",
    "ChoicePicker", "Slider", "DateTimeInput", "Tabs", "Table", "Chart", "Map", "Timeline", "Links", "Gallery", "Progress", "Steps",
)

/** What a surface draws, resolved from its components and data model. It holds only checked, ready-to-draw values. */
internal sealed interface SurfaceSpec {
    data object Empty : SurfaceSpec
    data class Stack(val children: List<SurfaceSpec>, val horizontal: Boolean = false) : SurfaceSpec
    data class Titled(val title: String, val body: SurfaceSpec) : SurfaceSpec
    data class Boxed(val child: SurfaceSpec) : SurfaceSpec
    data class Tabs(val titles: List<String>, val panes: List<SurfaceSpec>) : SurfaceSpec
    data class Markdown(val text: String) : SurfaceSpec
    data class Plain(val text: String, val small: Boolean = false) : SurfaceSpec
    data object Rule : SurfaceSpec
    data class Picture(val url: String, val description: String) : SurfaceSpec
    data class Link(val url: String, val label: String) : SurfaceSpec
    data class Action(val label: String, val source: JsonObject, val scope: String) : SurfaceSpec
    data class TextInput(
        val value: String, val label: String, val placeholder: String, val pointer: String?,
        val multiline: Boolean, val obscured: Boolean,
    ) : SurfaceSpec
    data class Toggle(val checked: Boolean, val label: String, val pointer: String?) : SurfaceSpec
    data class Choices(
        val label: String, val options: List<Pair<String, String>>, val selected: List<String>,
        val exclusive: Boolean, val pointer: String?,
    ) : SurfaceSpec
    data class Range(val label: String, val value: Float, val min: Float, val max: Float, val pointer: String?) : SurfaceSpec
    data class Meter(val label: String, val fraction: Float?, val bar: Boolean) : SurfaceSpec
    data class Form(val steps: List<Pair<String, SurfaceSpec>>, val submit: Action) : SurfaceSpec
    data class Table(
        val columns: List<Pair<String, String>>, val rows: List<Map<String, String>>, val sortable: Boolean,
        val filterable: Boolean, val pageSize: Int, val caption: String?,
    ) : SurfaceSpec
    data class Chart(val labels: List<String>, val series: List<Pair<String, List<Float?>>>, val unit: String) : SurfaceSpec
}

/** Thrown when a surface would draw more parts than a phone should lay out at once. */
internal class SurfaceTooLarge : IllegalStateException("This surface has too many parts to draw.")

/** The most parts one surface may draw, counting every repeat of a template. */
internal const val SURFACE_PART_LIMIT = 2_000

/** Resolves the whole surface from `root`. Throws when it cannot, and the caller shows the fallback text. */
internal fun resolveSurface(components: Map<String, JsonObject>, data: JsonObject): SurfaceSpec =
    SurfaceResolver(components, data).node("root", "", 0)

private class SurfaceResolver(val components: Map<String, JsonObject>, val data: JsonObject) {
    private var parts = 0

    fun node(id: String, scope: String, depth: Int): SurfaceSpec {
        if (depth > 40) return SurfaceSpec.Empty
        val component = components[id] ?: return SurfaceSpec.Empty
        if (++parts > SURFACE_PART_LIMIT) throw SurfaceTooLarge()
        fun resolved(key: String) = surfaceValue(component[key], data, scope)
        fun text(key: String) = resolved(key).text()
        val type = component.optionalString("component").orEmpty()
        val body = when (type) {
            "Column", "List" -> SurfaceSpec.Stack(children(component["children"], scope, depth))
            "Row" -> SurfaceSpec.Stack(children(component["children"], scope, depth), horizontal = true)
            "Card" -> SurfaceSpec.Boxed(node(text("child"), scope, depth + 1))
            "Tabs" -> component.objects("tabs").let { tabs ->
                SurfaceSpec.Tabs(
                    tabs.map { surfaceValue(it["title"], data, scope).text() },
                    tabs.map { node(it.optionalString("child").orEmpty(), scope, depth + 1) },
                )
            }
            "Text" -> text("text").takeIf { it.isNotBlank() }?.let(SurfaceSpec::Markdown) ?: SurfaceSpec.Empty
            "Icon" -> SurfaceSpec.Plain(text("name"))
            "Divider" -> SurfaceSpec.Rule
            "Image" -> text("url").takeIf { it.startsWith("https://", ignoreCase = true) }
                ?.let { SurfaceSpec.Picture(it, text("description")) } ?: SurfaceSpec.Empty
            "Button" -> {
                val labelNode = components[text("child")]
                val label = surfaceValue(labelNode?.get("text") ?: labelNode?.get("name"), data, scope).text()
                SurfaceSpec.Action(label.ifBlank { "Send" }, component, scope)
            }
            "TextField", "DateTimeInput" -> SurfaceSpec.TextInput(
                text("value"), text("label"), text("placeholder"), bindingPath(component["value"], scope),
                multiline = text("variant") == "longText", obscured = text("variant") == "obscured",
            )
            "CheckBox" -> SurfaceSpec.Toggle(text("value") == "true", text("label"), bindingPath(component["value"], scope))
            "ChoicePicker" -> SurfaceSpec.Choices(
                text("label"),
                component.objects("options").map {
                    surfaceValue(it["value"], data, scope).text() to surfaceValue(it["label"], data, scope).text()
                },
                (resolved("value") as? JsonArray).orEmpty().map { it.text() },
                exclusive = text("variant") == "mutuallyExclusive",
                pointer = bindingPath(component["value"], scope),
            )
            "Slider" -> {
                val min = text("min").toFloatOrNull() ?: 0f
                val max = text("max").toFloatOrNull() ?: 100f
                if (min.isFinite() && max.isFinite() && min < max) {
                    val value = (text("value").toFloatOrNull()?.takeIf { it.isFinite() } ?: min).coerceIn(min, max)
                    SurfaceSpec.Range(text("label"), value, min, max, bindingPath(component["value"], scope))
                } else SurfaceSpec.Empty
            }
            "Progress" -> SurfaceSpec.Meter(
                listOf(text("label"), text("status")).filter { it.isNotBlank() }.joinToString(" · "),
                text("value").toFloatOrNull()?.takeIf { it.isFinite() }?.let { (it / 100).coerceIn(0f, 1f) },
                bar = text("variant") != "status",
            )
            "Steps" -> if (text("variant") == "checklist") {
                SurfaceSpec.Stack(resolved("items").records().map { item ->
                    SurfaceSpec.Plain(listOfNotNull(item.optionalString("label"), item.optionalString("status")).joinToString(" · "))
                })
            } else {
                SurfaceSpec.Form(
                    component.objects("steps").map { step ->
                        surfaceValue(step["title"], data, scope).text() to node(step.optionalString("child").orEmpty(), scope, depth + 1)
                    },
                    SurfaceSpec.Action(text("submitLabel").ifBlank { "Submit" }, component, scope),
                )
            }
            "Table" -> {
                val columns = component.objects("columns").map { it.optionalString("key").orEmpty() to it.optionalString("label").orEmpty() }
                SurfaceSpec.Table(
                    columns,
                    resolved("rows").records().map { row -> row.mapValues { it.value.text() } },
                    sortable = component.optionalString("sortable") == "true",
                    filterable = component.optionalString("filterable") == "true",
                    pageSize = (component.optionalString("pageSize")?.toIntOrNull() ?: 20).coerceIn(5, 100),
                    caption = component.optionalString("caption"),
                )
            }
            "Chart" -> SurfaceSpec.Chart(
                (resolved("labels") as? JsonArray).orEmpty().map { it.text() },
                resolved("series").records().map { entry ->
                    entry.optionalString("name").orEmpty() to
                        (entry["values"] as? JsonArray).orEmpty().map { it.text().toFloatOrNull()?.takeIf(Float::isFinite) }
                },
                text("unit"),
            )
            "Gallery" -> SurfaceSpec.Stack(resolved("images").records().flatMap { image ->
                val caption = image.optionalString("caption").orEmpty()
                listOfNotNull(
                    image.optionalString("url")?.takeIf { it.startsWith("https://", ignoreCase = true) }?.let { SurfaceSpec.Picture(it, caption) },
                    caption.takeIf { it.isNotBlank() }?.let { SurfaceSpec.Plain(it) },
                    image.optionalString("link")?.let { SurfaceSpec.Link(it, "Open image link") },
                )
            })
            "Links" -> SurfaceSpec.Stack(resolved("links").records().flatMap { link ->
                val url = link.optionalString("url").orEmpty()
                listOfNotNull(SurfaceSpec.Link(url, link.optionalString("title") ?: url), link.optionalString("description")?.let { SurfaceSpec.Plain(it) })
            })
            "Timeline" -> SurfaceSpec.Stack(resolved("items").records().flatMap { item ->
                listOfNotNull(
                    SurfaceSpec.Plain(listOfNotNull(item.optionalString("date"), item.optionalString("time"), item.optionalString("title")).joinToString(" · ")),
                    item.optionalString("detail")?.let { SurfaceSpec.Plain(it, small = true) },
                    item.optionalString("location")?.let { SurfaceSpec.Plain(it, small = true) },
                )
            })
            "Map" -> SurfaceSpec.Stack(resolved("places").records().flatMap { place ->
                val name = place.optionalString("name").orEmpty()
                val lat = place.optionalString("lat")
                val lon = place.optionalString("lon")
                listOfNotNull(
                    if (lat != null && lon != null) SurfaceSpec.Link("https://www.openstreetmap.org/?mlat=$lat&mlon=$lon", name.ifBlank { "$lat,$lon" }) else null,
                    place.optionalString("note")?.let { SurfaceSpec.Plain(it) },
                )
            })
            else -> SurfaceSpec.Empty
        }
        val title = text("title")
        return if (title.isNotBlank() && type in setOf("Table", "Chart", "Map", "Timeline", "Gallery", "Links", "Steps")) {
            SurfaceSpec.Titled(title, body)
        } else body
    }

    fun children(children: JsonElement?, scope: String, depth: Int): List<SurfaceSpec> = when (children) {
        is JsonArray -> children.map { node(it.text(), scope, depth + 1) }
        is JsonObject -> {
            val componentId = children.optionalString("componentId")
            val path = children.optionalString("path")?.let { pointerPath(it, scope) }
            val values = path?.let { pointerGet(data, it) } as? JsonArray
            if (componentId == null || path == null || values == null) emptyList()
            else values.indices.take(100).map { node(componentId, "${path.trimEnd('/')}/$it", depth + 1) }
        }
        else -> emptyList()
    }
}

@Composable
private fun SurfaceView(engine: SurfaceEngine, spec: SurfaceSpec) {
    when (spec) {
        SurfaceSpec.Empty -> Unit
        is SurfaceSpec.Stack -> if (spec.horizontal) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                spec.children.forEachIndexed { index, child -> key(index) { SurfaceView(engine, child) } }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                spec.children.forEachIndexed { index, child -> key(index) { SurfaceView(engine, child) } }
            }
        }
        is SurfaceSpec.Titled -> {
            Text(spec.title, style = MaterialTheme.typography.titleSmall)
            SurfaceView(engine, spec.body)
        }
        is SurfaceSpec.Boxed -> Card { Column(Modifier.padding(8.dp)) { SurfaceView(engine, spec.child) } }
        is SurfaceSpec.Tabs -> SurfaceTabs(engine, spec)
        is SurfaceSpec.Markdown -> ReiMarkdown(spec.text, engine.api)
        is SurfaceSpec.Plain -> if (spec.small) Text(spec.text, style = MaterialTheme.typography.bodySmall) else Text(spec.text)
        SurfaceSpec.Rule -> HorizontalDivider()
        is SurfaceSpec.Picture -> MarkdownPicture(engine.api, spec.url, spec.description)
        is SurfaceSpec.Link -> SurfaceLink(spec.url, spec.label)
        is SurfaceSpec.Action -> SurfaceButton(engine, spec)
        is SurfaceSpec.TextInput -> ReiTextField(
            value = spec.value,
            onValueChange = { if (spec.pointer != null) engine.input(spec.pointer, JsonPrimitive(it)) },
            label = spec.label,
            placeholder = spec.placeholder.ifBlank { null },
            enabled = engine.interactive && spec.pointer != null && !engine.sending,
            singleLine = !spec.multiline,
            visualTransformation = if (spec.obscured) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = if (spec.obscured) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else KeyboardOptions.Default,
        )
        is SurfaceSpec.Toggle -> Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(
                checked = spec.checked,
                onCheckedChange = { if (spec.pointer != null) engine.input(spec.pointer, JsonPrimitive(it)) },
                enabled = engine.interactive && spec.pointer != null && !engine.sending,
            )
            Text(spec.label)
        }
        is SurfaceSpec.Choices -> {
            Text(spec.label)
            val enabled = engine.interactive && spec.pointer != null && !engine.sending
            spec.options.forEach { (value, label) ->
                val isSelected = value in spec.selected
                val updateSelection: (Boolean) -> Unit = { select ->
                    if (spec.pointer != null) {
                        val next = when {
                            !select -> spec.selected - value
                            spec.exclusive -> listOf(value)
                            else -> spec.selected + value
                        }
                        engine.input(spec.pointer, JsonArray(next.map(::JsonPrimitive)))
                    }
                }
                if (spec.exclusive) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .selectable(selected = isSelected, enabled = enabled, role = Role.RadioButton) {
                                updateSelection(true)
                            }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = isSelected, onClick = null, enabled = enabled)
                        Text(label, Modifier.padding(start = 8.dp))
                    }
                } else {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .toggleable(value = isSelected, enabled = enabled, role = Role.Checkbox) { select ->
                                updateSelection(select)
                            }
                            .padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = isSelected, onCheckedChange = null, enabled = enabled)
                        Text(label, Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
        is SurfaceSpec.Range -> {
            Text(spec.label)
            androidx.compose.material3.Slider(
                value = spec.value,
                onValueChange = { if (spec.pointer != null) engine.input(spec.pointer, JsonPrimitive(it)) },
                enabled = engine.interactive && spec.pointer != null,
                valueRange = spec.min..spec.max,
            )
        }
        is SurfaceSpec.Meter -> {
            if (spec.label.isNotBlank()) Text(spec.label)
            if (spec.bar) {
                val fraction = spec.fraction
                if (fraction == null) LinearProgressIndicator(Modifier.fillMaxWidth())
                else LinearProgressIndicator({ fraction }, Modifier.fillMaxWidth())
            }
        }
        is SurfaceSpec.Form -> SurfaceForm(engine, spec)
        is SurfaceSpec.Table -> SurfaceTable(spec)
        is SurfaceSpec.Chart -> SurfaceChart(spec)
    }
}

@Composable
private fun SurfaceTabs(engine: SurfaceEngine, spec: SurfaceSpec.Tabs) {
    var index by remember { mutableIntStateOf(0) }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        spec.titles.forEachIndexed { i, title ->
            FilterChip(selected = index == i, onClick = { index = i }, label = { Text(title) })
        }
    }
    spec.panes.getOrNull(index)?.let { SurfaceView(engine, it) }
}

@Composable
private fun SurfaceForm(engine: SurfaceEngine, spec: SurfaceSpec.Form) {
    var index by remember { mutableIntStateOf(0) }
    val (title, child) = spec.steps.getOrNull(index) ?: return
    Text(title, style = MaterialTheme.typography.labelLarge)
    SurfaceView(engine, child)
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (index > 0) TextButton(onClick = { index-- }) { Text("Back") }
        if (index < spec.steps.lastIndex) {
            TextButton(onClick = { index++ }) { Text("Next") }
        } else {
            SurfaceButton(engine, spec.submit)
        }
    }
}

@Composable
private fun SurfaceButton(engine: SurfaceEngine, spec: SurfaceSpec.Action) {
    val scope = rememberCoroutineScope()
    val source = spec.source
    val submitted = engine.sent == source.optionalString("id")
    Button(
        onClick = {
            engine.sending = true
            engine.failure = null
            scope.launch {
                try {
                    engine.send(source, spec.scope)
                } catch (failure: CancellationException) {
                    throw failure
                } catch (failure: Exception) {
                    engine.failure = failure.message ?: "Could not send this action."
                } finally {
                    engine.sending = false
                }
            }
        },
        enabled = engine.interactive && !engine.sending && source["action"] != null &&
            !(submitted && source.optionalString("component") == "Steps"),
    ) { Text(if (submitted) "Sent" else spec.label) }
}

@Composable
private fun SurfaceTable(spec: SurfaceSpec.Table) {
    var query by remember { mutableStateOf("") }
    var sort by remember { mutableStateOf<String?>(null) }
    var ascending by remember { mutableStateOf(true) }
    var page by remember { mutableIntStateOf(0) }
    if (spec.filterable) ReiTextField(
        query, { query = it; page = 0 }, label = "Filter rows", singleLine = true,
    )
    val matches = spec.rows.filter { row -> row.values.any { it.contains(query, ignoreCase = true) } }
    val ordered = sort?.let { key -> matches.sortedBy { it[key].orEmpty() }.let { if (ascending) it else it.asReversed() } } ?: matches
    Column(Modifier.horizontalScroll(rememberScrollState())) {
        Row {
            spec.columns.forEach { (key, name) ->
                if (spec.sortable) TextButton(onClick = {
                    ascending = if (sort == key) !ascending else true
                    sort = key
                    page = 0
                }, modifier = Modifier.width(120.dp)) { Text(name) }
                else Text(name, Modifier.width(120.dp).padding(8.dp), style = MaterialTheme.typography.labelLarge)
            }
        }
        HorizontalDivider()
        ordered.drop(page * spec.pageSize).take(spec.pageSize).forEach { row ->
            Row {
                spec.columns.forEach { (key, _) ->
                    Text(row[key].orEmpty(), Modifier.width(120.dp).padding(8.dp))
                }
            }
            HorizontalDivider()
        }
    }
    Row {
        if (page > 0) TextButton(onClick = { page-- }) { Text("Previous") }
        if (ordered.size > (page + 1) * spec.pageSize) TextButton(onClick = { page++ }) { Text("Next") }
    }
    spec.caption?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SurfaceChart(spec: SurfaceSpec.Chart) {
    val colors = ReiTheme.colors.charts
    val baselineColor = MaterialTheme.colorScheme.outlineVariant
    val values = spec.series.map { it.second }
    val nums = values.flatten().filterNotNull()
    val minVal = (nums.minOrNull() ?: 0f).coerceAtMost(0f)
    val maxVal = (nums.maxOrNull() ?: 0f).coerceAtLeast(0f)
    val span = (maxVal - minVal).coerceAtLeast(1f)
    if (spec.labels.isNotEmpty() && values.isNotEmpty()) {
        Canvas(Modifier.fillMaxWidth().height(130.dp)) {
            val baselineY = (maxVal / span) * size.height
            if (minVal < 0f && maxVal > 0f) {
                drawLine(baselineColor, Offset(0f, baselineY), Offset(size.width, baselineY), strokeWidth = 1.dp.toPx())
            }
            val barWidth = size.width / (spec.labels.size * values.size)
            for (i in spec.labels.indices) for (j in values.indices) {
                val value = values[j].getOrNull(i) ?: continue
                val barHeight = (kotlin.math.abs(value) / span) * size.height
                val top = if (value >= 0f) baselineY - barHeight else baselineY
                drawRect(
                    colors[j % colors.size],
                    topLeft = Offset((i * values.size + j) * barWidth, top),
                    size = Size(barWidth * 0.8f, barHeight),
                )
            }
        }
    }
    if (spec.series.any { it.first.isNotBlank() }) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.padding(top = 4.dp),
        ) {
            spec.series.forEachIndexed { index, (name, _) ->
                if (name.isNotBlank()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(colors[index % colors.size]))
                        Text(name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
    spec.labels.forEachIndexed { index, label ->
        val columns = spec.series.mapNotNull { (name, series) ->
            series.getOrNull(index)?.let { value -> "$name $value ${spec.unit}".trim() }
        }
        Text(listOf(label, columns.joinToString(" · ")).filter { it.isNotBlank() }.joinToString(" · "))
    }
}

@Composable
private fun SurfaceLink(url: String, label: String) {
    val context = LocalContext.current
    if (isExternalMarkdownLink(url)) TextButton(onClick = { openExternalLink(context, url) }) { Text(label) }
}

@Composable
private fun SurfaceInspector(api: ReiApi, sessionId: String, id: String, title: String, dismiss: () -> Unit) {
    var answer by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(api, sessionId, id) {
        try {
            answer = api.request("GET", listOf("api", "sessions", sessionId, "surfaces", id))
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            error = failure.message ?: "Could not load this surface."
        }
    }
    ReiSheet(onDismiss = dismiss, title = "Inspect ${title.ifBlank { "surface" }}") {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val data = answer
            if (data == null && error == null) CircularProgressIndicator(Modifier.padding(vertical = 8.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (data != null) for ((field, heading) in listOf("revisions" to "Revisions", "actions" to "Actions", "failures" to "Failures")) {
                Text(heading, style = MaterialTheme.typography.titleSmall)
                val entries = data.objects(field).asReversed()
                if (entries.isEmpty()) Text("None", color = MaterialTheme.colorScheme.onSurfaceVariant)
                entries.forEach { entry ->
                    var expanded by remember(entry) { mutableStateOf(false) }
                    val description = listOfNotNull(
                        entry.optionalString("revision")?.let { "#$it" },
                        entry.optionalString("summary") ?: entry.optionalString("decision") ?: entry.optionalString("tool"),
                    ).joinToString(" ")
                    TextButton(onClick = { expanded = !expanded }) { Text(description.ifBlank { "Details" }) }
                    if (expanded) SelectionContainer { Text(prettyJson.encodeToString(JsonObject.serializer(), entry)) }
                }
            }
        }
    }
}

private fun JsonElement?.text(): String = when (this) {
    null, JsonNull -> ""
    is JsonPrimitive -> content
    else -> toString()
}

private fun JsonElement?.records() = (this as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }

private fun bindingPath(value: JsonElement?, scope: String): String? =
    (value as? JsonObject)?.optionalString("@path")?.let { pointerPath(it, scope) }

private fun pointerPath(value: String, scope: String): String = when {
    value.startsWith("/") -> value
    value.isBlank() || value == "." -> scope.ifBlank { "/" }
    else -> "${scope.trimEnd('/')}/$value"
}

private fun pointerParts(path: String) = if (path == "/" || path == "") emptyList() else
    path.trimStart('/').split('/').map { it.replace("~1", "/").replace("~0", "~") }

internal fun pointerGet(data: JsonElement, path: String): JsonElement? = pointerParts(path).fold<String, JsonElement?>(data) { node, key ->
    when (node) {
        is JsonObject -> node[key]
        is JsonArray -> key.toIntOrNull()?.let { node.getOrNull(it) }
        else -> null
    }
}

internal fun pointerSet(data: JsonElement, path: String, value: JsonElement): JsonElement {
    fun replace(node: JsonElement?, keys: List<String>): JsonElement {
        if (keys.isEmpty()) return value
        val key = keys.first()
        val rest = keys.drop(1)
        val index = key.toIntOrNull()
        if (node is JsonArray && index != null && index in node.indices) {
            return JsonArray(node.toMutableList().apply { set(index, replace(node[index], rest)) })
        }
        val objectNode = node as? JsonObject ?: JsonObject(emptyMap())
        return JsonObject(objectNode + (key to replace(objectNode[key], rest)))
    }
    return replace(data, pointerParts(path))
}

// Android's ICU regex rejects an unescaped `}`, which the JVM accepts, so escape every brace.
private val interpolation = Regex("\\\\?\\$\\{([^}]*)\\}")

internal fun surfaceValue(value: JsonElement?, data: JsonObject, scope: String): JsonElement? {
    val objectValue = value as? JsonObject ?: return value
    bindingPath(objectValue, scope)?.let { return pointerGet(data, it) }
    val call = objectValue.optionalString("@call")
    val args = objectValue["args"] as? JsonObject
    return when (call) {
        "formatString" -> JsonPrimitive(interpolation.replace(surfaceValue(args?.get("value"), data, scope).text()) { match ->
            if (match.value.startsWith("\\")) match.value.drop(1)
            else pointerGet(data, pointerPath(match.groupValues[1].trim(), scope)).text()
        })
        "@index" -> JsonPrimitive((scope.substringAfterLast('/').toIntOrNull() ?: 0) + (args?.optionalString("offset")?.toIntOrNull() ?: 0))
        else -> if (call == null) value else null
    }
}
