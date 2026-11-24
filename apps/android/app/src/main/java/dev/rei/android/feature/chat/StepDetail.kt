package dev.rei.android.feature.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.PrimaryScrollableTabRow
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
import android.content.res.Resources
import androidx.annotation.StringRes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rei.android.R
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

private val WhitespaceRegex = Regex("\\s+")

private enum class LlmTab(@StringRes val labelRes: Int) {
    Context(R.string.chat_step_tab_context),
    Response(R.string.chat_step_tab_response),
    Raw(R.string.chat_step_tab_raw),
    Stats(R.string.chat_step_tab_stats),
}

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
    val resources = LocalResources.current
    var payload by remember(step.id) { mutableStateOf<JsonObject?>(null) }
    var error by remember(step.id) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable(step.id) { mutableStateOf(LlmTab.Context) }
    LaunchedEffect(step.id, step.status) {
        try {
            payload = api.stepDetail(step.id)
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            error = failure.message ?: resources.getString(R.string.chat_step_load_failed)
        }
    }
    val data = payload
    val llm = data?.get("llm").obj()
    val truncated = data?.get("truncated").flag()
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            ReiIconButton(ReiIcons.Back, stringResource(R.string.chat_step_back), onBack, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(activityIcon(step), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                activityLabel(step).asString(),
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
                val largeFont = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.3f
                val tabsContent: @Composable () -> Unit = {
                    LlmTab.entries.forEach { entry ->
                        Tab(
                            selected = tab == entry,
                            onClick = { tab = entry },
                            text = { Text(stringResource(entry.labelRes), style = MaterialTheme.typography.labelLarge, maxLines = 1) },
                            modifier = Modifier.heightIn(min = 48.dp),
                        )
                    }
                }
                if (largeFont) {
                    PrimaryScrollableTabRow(
                        selectedTabIndex = tab.ordinal,
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                        edgePadding = 0.dp,
                        tabs = tabsContent,
                    )
                } else {
                    PrimaryTabRow(
                        selectedTabIndex = tab.ordinal,
                        containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
                        tabs = tabsContent,
                    )
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
                        if (truncated) Note(stringResource(R.string.chat_step_truncated_note))
                        JsonView(stringResource(R.string.chat_step_raw_label), llm)
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
    val view = remember(request) { describeRequest(request) }
    if (!view.recognised) {
        Quiet(stringResource(R.string.chat_step_context_unrecognised))
        return
    }
    val sections = view.system?.let(::systemSections).orEmpty()
    val updates = view.messages.count { it.update }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (truncated) Note(stringResource(R.string.chat_step_truncated_note))
        view.system?.let { system ->
            Column {
                SectionLabel(
                    if (sections.size > 1) {
                        stringResource(R.string.chat_step_system_prompt_sections, sections.size)
                    } else {
                        stringResource(R.string.chat_step_system_prompt)
                    },
                )
                if (sections.size > 1) {
                    sections.forEach { s ->
                        Collapsible({ Text(s.title?.let(::promptSectionLabel) ?: sectionOpening(s.body).asString(), fontWeight = FontWeight.Medium) }) { LongText(s.body) }
                    }
                } else {
                    Collapsible({ Text(stringResource(R.string.chat_step_system_prompt), fontWeight = FontWeight.Medium) }, initiallyOpen = true) { LongText(system) }
                }
            }
        }
        Column {
            val baseMessages = stringResource(R.string.chat_step_messages_header, view.messages.size)
            SectionLabel(
                if (updates > 0) {
                    val updatesText = pluralStringResource(R.plurals.chat_step_prompt_updates, updates, updates)
                    stringResource(R.string.chat_step_messages_header_updates, view.messages.size, updatesText)
                } else {
                    baseMessages
                },
            )
            view.messages.forEach { MessageItem(it) }
        }
        if (view.tools.isNotEmpty()) {
            Column {
                SectionLabel(stringResource(R.string.chat_step_tools_header, view.tools.size))
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
    val resources = LocalResources.current
    if (m.update) {
        val changes = sectionChanges(m.text)
        val peek = changes.joinToString(" · ") {
            when {
                it.name.isEmpty() -> resources.getString(R.string.chat_step_system_message)
                it.removed -> resources.getString(R.string.chat_step_prompt_update_removed, it.name)
                else -> resources.getString(R.string.chat_step_prompt_update_updated, it.name)
            }
        }
        Collapsible({ RolePill(stringResource(R.string.chat_step_prompt_update_pill)); Peek(peek) }) {
            changes.forEach { c ->
                if (c.name.isNotEmpty()) {
                    Note(
                        stringResource(
                            if (c.removed) R.string.chat_step_section_removed else R.string.chat_step_section_replaced,
                            c.name,
                        ),
                    )
                }
                if (c.body.isNotEmpty()) LongText(c.body)
            }
        }
        return
    }
    val attachmentCountText = if (m.other > 0) pluralStringResource(R.plurals.chat_step_attachments, m.other, m.other) else ""
    val encryptedNote = if (m.encryptedReasoning) stringResource(R.string.chat_step_encrypted_reasoning) else ""
    val displayText = m.text.ifEmpty { encryptedNote }
    val peek = displayText.ifEmpty { m.calls.firstOrNull() ?: attachmentCountText }
    Collapsible({ RolePill(m.role); Peek(peek.replace(WhitespaceRegex, " ").take(90)) }) {
        if (m.reasoning.isNotEmpty()) {
            Note(stringResource(R.string.chat_step_reasoning))
            LongText(m.reasoning)
        }
        if (displayText.isNotEmpty()) LongText(displayText)
        m.calls.forEach { LongText("→ $it", mono = true) }
        if (m.other > 0) Note(stringResource(R.string.chat_step_attachments_hidden_note, attachmentCountText))
    }
}

@Composable
private fun ResponseView(response: JsonElement?) {
    val view = remember(response) { describeResponse(response) }
    if (!view.recognised) {
        Quiet(stringResource(R.string.chat_step_no_response))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (view.reasoning.isNotEmpty()) {
            Column {
                SectionLabel(stringResource(R.string.chat_step_reasoning))
                LongText(view.reasoning)
            }
        }
        if (view.text.isNotEmpty()) LongText(view.text)
        if (view.calls.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionLabel(stringResource(R.string.chat_step_tool_calls))
                view.calls.forEach { LongText(it, mono = true) }
            }
        }
    }
}

@Composable
private fun Stats(step: TraceStep, data: JsonObject?) {
    val resources = LocalResources.current
    val summary = data?.get("step").obj()
    val tokens = summary?.get("tokens").obj()
    fun num(key: String) = tokens?.get(key).number()?.let(::groupedNumber) ?: "–"
    val prefix = summary?.get("prefix").obj()
    val rows = buildList {
        add(resources.getString(R.string.chat_step_stat_model) to (summary?.get("model").text() ?: step.model ?: "–"))
        add(resources.getString(R.string.chat_step_stat_provider) to (summary?.get("providerName").text() ?: "–"))
        add(resources.getString(R.string.chat_inspect_status) to activityStatus(step).asString(resources) + (step.errorCode?.let { " ($it)" } ?: ""))
        add(resources.getString(R.string.chat_step_stat_started) to formatWhen(step.startedAt))
        add(resources.getString(R.string.chat_step_stat_input_tokens) to num("input"))
        add(resources.getString(R.string.chat_step_stat_output_tokens) to num("output"))
        add(resources.getString(R.string.chat_step_stat_cached_tokens) to num("cached"))
        if (prefix != null) {
            val matched = prefix["matched"].number()
            add(
                resources.getString(R.string.chat_step_stat_prefix) to if (matched == null) {
                    resources.getString(R.string.chat_step_stat_prefix_first)
                } else {
                    resources.getString(R.string.chat_step_stat_prefix_matched, matched, prefix["items"].number() ?: 0)
                },
            )
        }
        add(resources.getString(R.string.chat_step_stat_reasoning_tokens) to num("reasoning"))
        add(resources.getString(R.string.chat_step_stat_total_tokens) to num("total"))
        add(resources.getString(R.string.chat_step_stat_first_byte) to (summary?.get("firstByteMs").number()?.let { duration(it).asString(resources) } ?: "–"))
        add(resources.getString(R.string.chat_step_stat_latency) to duration(step.latencyMs).asString(resources))
        data?.get("payloadBytes").number()?.let {
            val resId = if (data?.get("truncated").flag()) R.string.chat_step_bytes_cut else R.string.chat_step_bytes
            add(resources.getString(R.string.chat_step_stat_recorded_size) to resources.getString(resId, groupedNumber(it)))
        }
    }
    Facts(rows)
}

/** The tools a model call was offered and what changed since the previous call. */
@Composable
private fun OfferedTools(tools: JsonObject, onOpenStep: (String) -> Unit) {
    val resources = LocalResources.current
    val offered = tools["offered"].strings()
    val added = (tools["added"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val removed = tools["removed"].strings()
    Column {
        SectionLabel(stringResource(R.string.chat_step_offered_tools, offered.size))
        when {
            tools["previousStepId"].text() == null -> Note(stringResource(R.string.chat_step_offered_first))
            added.isEmpty() && removed.isEmpty() -> Note(stringResource(R.string.chat_step_offered_same))
            else -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                added.forEach { a ->
                    val loadedBy = a["loadedBy"].text()
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("+", style = MaterialTheme.typography.bodyMedium)
                        Column {
                            Text(a["name"].text().orEmpty(), style = MaterialTheme.typography.bodySmall.mono())
                            if (loadedBy != null) {
                                val why = a["reason"].text()?.let { loadReason(resources, it) }?.let { r -> " ($r${a["group"].text()?.let { g -> ": $g" } ?: ""})" }.orEmpty()
                                Box(
                                    Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { onOpenStep(loadedBy) },
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    Text(
                                        stringResource(R.string.chat_step_loaded_search, why),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            } else {
                                Text(stringResource(R.string.chat_step_offered_again), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                removed.forEach { name ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("−", style = MaterialTheme.typography.bodyMedium)
                        Column {
                            Text(name, style = MaterialTheme.typography.bodySmall.mono())
                            Text(stringResource(R.string.chat_step_no_longer_offered), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
        Collapsible({ Text(stringResource(R.string.chat_step_all_offered_tools), fontWeight = FontWeight.Medium) }) {
            Text(offered.joinToString(", "), Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall.mono())
        }
    }
}

private fun loadReason(resources: Resources, reason: String) = when (reason) {
    "group" -> resources.getString(R.string.chat_step_reason_group)
    "ranked" -> resources.getString(R.string.chat_step_reason_ranked)
    "load" -> resources.getString(R.string.chat_step_reason_load)
    else -> reason
}

// ---- tool call ----------------------------------------------------------------------------------------------------

@Composable
private fun ToolDetail(api: ReiApi, step: TraceStep, data: JsonObject?, onOpenApproval: (() -> Unit)?) {
    val resources = LocalResources.current
    val summary = data?.get("step").obj()
    val tool = data?.get("tool").obj()
    val actionClass = summary?.get("actionClass").text()
    val decision = step.decision?.let { decisionLabel(it).asString(resources) } ?: "–"
    val decisionLabelKey = resources.getString(R.string.chat_step_decision_label)
    Facts(
        buildList {
            add(resources.getString(R.string.chat_step_tool_label) to (step.toolName ?: "–"))
            add(resources.getString(R.string.chat_step_class_label) to (actionClassLabel(actionClass).asString(resources)))
            add(
                decisionLabelKey to if (step.approvalId != null && onOpenApproval == null) {
                    resources.getString(R.string.chat_step_decision_approval, decision)
                } else {
                    decision
                },
            )
            add(resources.getString(R.string.chat_inspect_status) to activityStatus(step).asString(resources))
            step.summary?.let { add(resources.getString(R.string.chat_step_summary_label) to it) }
            add(resources.getString(R.string.chat_step_stat_started) to formatWhen(step.startedAt))
            add(resources.getString(R.string.chat_step_time_label) to duration(step.latencyMs).asString(resources))
            if (step.sideEffect) add(resources.getString(R.string.chat_step_effect_label) to resources.getString(R.string.chat_step_effect_outside))
        },
        links = if (step.approvalId != null && onOpenApproval != null) mapOf(decisionLabelKey to FactLink(resources.getString(R.string.chat_step_see_approval), onOpenApproval)) else emptyMap(),
    )
    if (tool == null) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (data?.get("truncated").flag()) Note(stringResource(R.string.chat_step_truncated_note))
        if (tool["isError"].flag()) Note(stringResource(R.string.chat_step_tool_error), error = true)
        tool["discovery"].obj()?.let { Discovery(it) }
        tool["fetch"].obj()?.let { WebFetch(it) }
        JsonView(stringResource(R.string.chat_step_input_label), tool["input"])
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionLabel(stringResource(R.string.chat_step_output_label))
            val output = (tool["output"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
            if (output.isEmpty()) Quiet(stringResource(R.string.chat_step_no_output))
            output.forEach { part ->
                if (part["type"].text() == "text") {
                    LongText(part["text"].text().orEmpty())
                } else {
                    val imageIndex = (part["index"].number() ?: 0).toInt()
                    val toolName = step.toolName ?: stringResource(R.string.chat_step_tool_noun)
                    StepImage(api, step.id, imageIndex, stringResource(R.string.chat_step_tool_image, imageIndex + 1, toolName))
                }
            }
        }
    }
}

private val CacheLabelRes = mapOf(
    "hit" to R.string.chat_step_cache_hit,
    "miss" to R.string.chat_step_cache_miss,
    "refresh" to R.string.chat_step_cache_refresh,
)
private val ModeLabelRes = mapOf(
    "overview" to R.string.chat_step_mode_overview,
    "whole" to R.string.chat_step_mode_whole,
    "query" to R.string.chat_step_mode_query,
    "section" to R.string.chat_step_mode_section,
    "offset" to R.string.chat_step_mode_offset,
)

private fun renderSummary(resources: Resources, r: JsonObject): String {
    when (r["skipped"].text()) {
        "off" -> return resources.getString(R.string.chat_step_render_off)
        "unavailable" -> return resources.getString(R.string.chat_step_render_unavailable)
    }
    if (r["failed"].flag()) return resources.getString(R.string.chat_step_render_failed)
    val parts = mutableListOf(
        when (r["reason"].text()) {
            "forced" -> resources.getString(R.string.chat_step_render_forced)
            "low_quality" -> resources.getString(R.string.chat_step_render_low_quality)
            else -> resources.getString(R.string.chat_step_render_js)
        },
    )
    r["ended"].text()?.let {
        parts += resources.getString(if (it == "stable") R.string.chat_step_render_settled else R.string.chat_step_render_deadline)
    }
    if (r["truncated"].flag()) parts += resources.getString(R.string.chat_step_render_html_cut)
    return parts.joinToString(", ")
}

/** How a web_fetch got its page and what it showed the model. */
@Composable
private fun WebFetch(d: JsonObject) {
    val resources = LocalResources.current
    fun num(key: String) = d[key].number()?.let(::groupedNumber)
    val render = d["render"].obj()
    Column {
        SectionLabel(stringResource(R.string.chat_step_fetch_header))
        Facts(
            buildList {
                add(resources.getString(R.string.chat_step_fetch_host) to d["host"].text().orEmpty())
                d["title"].text()?.let { add(resources.getString(R.string.chat_step_fetch_title) to it) }
                add(resources.getString(R.string.chat_step_fetch_source) to (CacheLabelRes[d["cache"].text()]?.let(resources::getString) ?: "–"))
                add(
                    resources.getString(R.string.chat_step_fetch_method) to resources.getString(
                        if (d["method"].text() == "render") R.string.chat_step_fetch_method_render else R.string.chat_step_fetch_method_http,
                    ),
                )
                render?.let { r ->
                    add(resources.getString(R.string.chat_step_fetch_rendering) to renderSummary(resources, r))
                    r["queueMs"].number()?.takeIf { it > 0 }?.let { add(resources.getString(R.string.chat_step_fetch_waited) to duration(it).asString(resources)) }
                    r["engine"].text()?.let { engine ->
                        val version = r["engineVersion"].text()?.let { " $it" }.orEmpty()
                        val fallback = r["fallback"].obj()?.let {
                            resources.getString(R.string.chat_step_fetch_engine_fallback, it["from"].text().orEmpty(), it["reason"].text().orEmpty())
                        }.orEmpty()
                        add(resources.getString(R.string.chat_step_fetch_engine) to "$engine$version$fallback")
                    }
                    r["renderMs"].number()?.let { add(resources.getString(R.string.chat_step_fetch_render_time) to duration(it).asString(resources)) }
                    r["connections"].number()?.let { c ->
                        val refused = r["refused"].number()?.takeIf { it > 0 }
                        val value = if (refused != null) {
                            resources.getString(R.string.chat_step_fetch_connections_refused, groupedNumber(c), groupedNumber(refused))
                        } else {
                            groupedNumber(c)
                        }
                        add(resources.getString(R.string.chat_step_fetch_connections) to value)
                    }
                    r["blockedMedia"].number()?.takeIf { it > 0 }?.let { add(resources.getString(R.string.chat_step_fetch_blocked_media) to groupedNumber(it)) }
                }
                d["mode"].text()?.let { mode ->
                    add(resources.getString(R.string.chat_step_fetch_shown) to (ModeLabelRes[mode]?.let(resources::getString) ?: mode))
                }
                d["sections"].strings().takeIf { it.isNotEmpty() }?.let { add(resources.getString(R.string.chat_step_fetch_sections) to it.joinToString(", ")) }
                d["status"].number()?.let { add(resources.getString(R.string.chat_step_fetch_http_status) to it.toString()) }
                d["redirects"].number()?.let { add(resources.getString(R.string.chat_step_fetch_redirects) to it.toString()) }
                d["mediaType"].text()?.let { add(resources.getString(R.string.chat_step_fetch_media_type) to it) }
                num("bytes")?.let { add(resources.getString(R.string.chat_step_fetch_downloaded) to resources.getString(R.string.chat_step_bytes, it)) }
                d["extractor"].text()?.let { add(resources.getString(R.string.chat_step_fetch_extractor) to it) }
                d["quality"].text()?.let { add(resources.getString(R.string.chat_step_fetch_quality) to it) }
                num("tokensReturned")?.let { add(resources.getString(R.string.chat_step_fetch_tokens_returned) to it) }
                num("pageTokens")?.let { add(resources.getString(R.string.chat_step_fetch_page_tokens) to it) }
                add(resources.getString(R.string.chat_inspect_duration) to duration(d["durationMs"].number()).asString(resources))
            },
        )
    }
}

/** What a search_capabilities call searched, ranked, loaded and suggested. */
@Composable
private fun Discovery(d: JsonObject) {
    val resources = LocalResources.current
    val loaded = (d["loaded"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val candidates = (d["candidates"] as? JsonArray).orEmpty().mapNotNull { it.obj() }
    val directory = d["directory"].obj()
    Column {
        SectionLabel(stringResource(R.string.chat_step_discovery_header))
        Facts(
            buildList {
                d["query"].text()?.takeIf { it.isNotEmpty() }?.let { add(resources.getString(R.string.chat_step_discovery_query) to "“$it”") }
                directory?.let {
                    val tools = (it["tools"].number() ?: 0).toInt()
                    val toolsText = resources.getQuantityString(R.plurals.chat_step_tools_listed, tools, tools)
                    add(
                        resources.getString(R.string.chat_step_discovery_directory) to resources.getString(
                            R.string.chat_step_discovery_directory_value,
                            it["connectorName"].text().orEmpty(),
                            toolsText,
                        ),
                    )
                }
                add(
                    resources.getString(R.string.chat_step_discovery_loaded) to if (loaded.isEmpty()) {
                        resources.getString(R.string.chat_step_discovery_nothing)
                    } else {
                        loaded.joinToString("\n") { l ->
                            l["name"].text().orEmpty() + " · " + loadReason(resources, l["reason"].text().orEmpty()) + (l["group"].text()?.let { " ($it)" } ?: "")
                        }
                    },
                )
                names(resources.getString(R.string.chat_step_discovery_already_loaded), d["alreadyLoaded"].strings())?.let(::add)
                names(resources.getString(R.string.chat_step_discovery_also_relevant), d["alsoRelevant"].strings())?.let(::add)
                names(resources.getString(R.string.chat_step_discovery_skills), d["skills"].strings())?.let(::add)
                names(resources.getString(R.string.chat_step_discovery_not_found), d["notFound"].strings())?.let(::add)
            },
        )
        if (candidates.isNotEmpty()) {
            Collapsible({ Text(stringResource(R.string.chat_step_discovery_candidates, candidates.size), fontWeight = FontWeight.Medium) }) {
                Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    candidates.forEach { c ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                            Text(c["name"].text().orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.mono())
                            Text(c["kind"].text().orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                stringResource(
                                    R.string.chat_step_candidate_score,
                                    Math.round((c["coverage"].text()?.toDoubleOrNull() ?: 0.0) * 100),
                                    c["score"].text().orEmpty(),
                                ),
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
            change?.let { add(stringResource(R.string.chat_step_change_connectors) to it["connectors"].strings().joinToString(", ")) }
            add(stringResource(R.string.chat_step_change_seen) to formatWhen(step.startedAt))
        },
    )
    if (change != null) {
        Facts(
            listOfNotNull(
                names(stringResource(R.string.chat_step_change_added), change["added"].strings()),
                names(stringResource(R.string.chat_step_change_removed), change["removed"].strings()),
                names(stringResource(R.string.chat_step_change_changed), change["changed"].strings()),
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
                .clickable(onClickLabel = stringResource(R.string.chat_step_image_view), role = Role.Button) { viewing = true },
            contentScale = ContentScale.FillWidth,
        )
        loaded.first -> Note(stringResource(R.string.chat_step_image_failed, description))
        else -> Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
    }
    if (viewing) ImageViewer(description, onDismiss = { viewing = false }, key = stepId to index) { loadStepImage(api, stepId, index, 2400) }
}

/** Label and value pairs in two columns: the label fixed-width and quiet, the value free to wrap. */
@Composable
internal fun Facts(rows: List<Pair<String, String>>, modifier: Modifier = Modifier, links: Map<String, FactLink> = emptyMap()) {
    if (rows.isEmpty()) return
    val stacked = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.3f
    SelectionContainer {
        Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(if (stacked) 10.dp else 6.dp)) {
            rows.forEach { (label, value) ->
                val link = links[label]
                val valueContent: @Composable (Modifier) -> Unit = { valueMod ->
                    if (link == null) {
                        Text(value, valueMod, style = MaterialTheme.typography.bodyMedium.tabular())
                    } else {
                        val linkStyle = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary, textDecoration = TextDecoration.Underline))
                        Text(
                            buildAnnotatedString {
                                append("$value · ")
                                withLink(LinkAnnotation.Clickable("fact", linkStyle) { link.onClick() }) { append(link.text) }
                            },
                            valueMod,
                            style = MaterialTheme.typography.bodyMedium.tabular(),
                        )
                    }
                }
                if (stacked) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        valueContent(Modifier.fillMaxWidth())
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(label, Modifier.width(112.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        valueContent(Modifier.weight(1f))
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
        val clickLabel = stringResource(if (open) R.string.common_collapse else R.string.common_expand)
        val toggleState = stringResource(if (open) R.string.common_expanded else R.string.common_collapsed)
        Column {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable(onClickLabel = clickLabel, role = Role.Button) { open = !open }
                    .semantics { stateDescription = toggleState }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp), content = summary)
                val collapsedRotation = if (LocalLayoutDirection.current == LayoutDirection.Rtl) 90f else -90f
                Icon(
                    ReiIcons.Chevron,
                    null,
                    Modifier.size(16.dp).rotate(if (open) 0f else collapsedRotation),
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
                    if (all) stringResource(R.string.chat_step_long_show_less)
                    else stringResource(R.string.chat_step_long_show_more, groupedNumber((text.length - LongTextLimit).toLong())),
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
            ReiIconButton(ReiIcons.Copy, stringResource(R.string.chat_step_copy_item, label.lowercase(Locale.ROOT)), { copyToClipboard(context, label, text) }, tint = MaterialTheme.colorScheme.onSurfaceVariant, iconSize = 16.dp)
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
    val skeleton = if (calendar.get(java.util.Calendar.YEAR) == today.get(java.util.Calendar.YEAR)) "MMMd" else "yMMMd"
    val pattern = runCatching { android.text.format.DateFormat.getBestDateTimePattern(locale, skeleton) }
        .getOrElse { if (skeleton == "MMMd") "MMM d" else "MMM d, yyyy" }
    return java.text.SimpleDateFormat(pattern, locale).format(Date(ts)) + ", " + time
}
