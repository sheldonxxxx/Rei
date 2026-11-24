package dev.rei.android.feature.settings

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
import dev.rei.android.data.ModelCatalog
import dev.rei.android.data.ReiApi
import dev.rei.android.data.models
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One model's limits as the server reports them: the value (null when unknown) and where it came from. */
internal data class Limit(val value: Long?, val source: String?)

internal data class Capability(val id: String, val contextWindow: Limit, val maxTokens: Limit)

private data class ModelsData(
    val standard: String,
    val fast: String,
    val capabilities: List<Capability>,
    val catalog: ModelCatalog,
    /** Ids of the custom endpoints; only those can be scanned for limits. */
    val customConnections: Set<String>,
)

internal fun JsonObject.limit(key: String): Limit =
    (this[key] as? JsonObject)?.let { Limit(it.optionalString("value")?.toLongOrNull(), it.optionalString("source")) } ?: Limit(null, null)

internal fun parseCapabilities(body: JsonObject): List<Capability> =
    body.objects("capabilities").map { Capability(it.string("id"), it.limit("contextWindow"), it.limit("maxTokens")) }

/** The text a limit field starts with: only a value the user set is editable; anything else shows as the placeholder. */
internal fun customLimitText(limit: Limit): String = if (limit.source == "custom" && limit.value != null) limit.value.toString() else ""

/** The `capabilities` patch for one model, or the message to show when a field is not a valid number. */
internal fun limitPatch(label: String, context: String, maxOutput: String): Pair<JsonObject?, UiText?> {
    fun field(text: String, fieldLabel: UiText): Pair<JsonElement?, UiText?> = when (val parsed = parseLimit(text)) {
        LimitInput.Clear -> JsonNull to null
        is LimitInput.Value -> JsonPrimitive(parsed.tokens) to null
        LimitInput.Invalid -> null to UiText.Resource(R.string.settings_models_limit_error, fieldLabel, label)
    }
    val ctx = field(context, UiText.Resource(R.string.settings_models_context_window))
    ctx.second?.let { return null to it }
    val max = field(maxOutput, UiText.Resource(R.string.settings_models_max_output))
    max.second?.let { return null to it }
    return buildJsonObject { put("contextWindow", ctx.first!!); put("maxTokens", max.first!!) } to null
}

private suspend fun loadModels(api: ReiApi): ModelsData {
    val settings = api.request("GET", listOf("api", "settings", "models"))
    val catalog = api.models()
    val providers = suspendRunCatching { api.request("GET", listOf("api", "providers")).objects("connections") }.getOrDefault(emptyList())
    return ModelsData(
        standard = settings.obj("standard").string("model"),
        fast = settings.obj("fast").string("model"),
        capabilities = parseCapabilities(settings),
        catalog = catalog,
        customConnections = providers.filter { it.optionalString("kind") == "openai-compatible" }.map { it.string("id") }.toSet(),
    )
}

/**
 * Models: the default model for agent chats and for background tasks, and the context window and output limit of any model.
 * A default saves as soon as it is picked; limits save with the button.
 */
@Composable
fun ModelsScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val data = rememberResource(api) { loadModels(api) }
    var limitModel by rememberSaveable { mutableStateOf<String?>(null) }
    var drafts by remember { mutableStateOf<Map<String, Pair<String, String>>>(emptyMap()) }
    var problem by remember { mutableStateOf<UiText?>(null) }
    var scanStatus by remember { mutableStateOf<UiText?>(null) }
    SubScreen(stringResource(R.string.settings_page_models), onBack, busy = writes.busy || data.loading, error = problem ?: writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            val models = loaded.catalog.models
            fun label(model: String) = loaded.catalog.labels[model] ?: model
            if (models.isEmpty()) {
                EmptyState(ReiIcons.Brain, stringResource(R.string.settings_models_empty_title), body = stringResource(R.string.settings_models_empty_body))
            } else {
                fun choices(current: String) = buildList {
                    if (current !in models) add(Choice(current, UiText.Resource(R.string.settings_general_titles_model_unavail), enabled = false))
                    models.forEach { add(Choice(it, label(it))) }
                }
                SettingsGroup(title = stringResource(R.string.settings_models_defaults_group)) {
                    ChoiceRow(
                        stringResource(R.string.settings_models_agent_chats), loaded.standard, choices(loaded.standard), icon = ReiIcons.Chat, summary = stringResource(R.string.settings_models_agent_chats_summary),
                        enabled = !writes.busy, dividerBelow = true,
                        onSelect = { model -> writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "models"), buildJsonObject { put("standard", buildJsonObject { put("model", model) }) }) } },
                    )
                    ChoiceRow(
                        stringResource(R.string.settings_models_background_tasks), loaded.fast, choices(loaded.fast), icon = ReiIcons.Sparkle,
                        summary = stringResource(R.string.settings_models_background_tasks_summary),
                        enabled = !writes.busy,
                        onSelect = { model -> writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "models"), buildJsonObject { put("fast", buildJsonObject { put("model", model) }) }) } },
                    )
                }
                val selected = limitModel?.takeIf { it in models } ?: loaded.standard.takeIf { it in models } ?: models.first()
                val capability = loaded.capabilities.firstOrNull { it.id == selected }
                SettingsGroup(title = stringResource(R.string.settings_models_limits_group)) {
                    ChoiceRow(
                        stringResource(R.string.settings_models_model), selected, models.map { Choice(it, label(it)) }, icon = ReiIcons.Brain,
                        summary = stringResource(R.string.settings_models_limits_summary),
                        enabled = !writes.busy,
                        onSelect = { limitModel = it; problem = null; scanStatus = null },
                    )
                }
                if (capability == null) {
                    SettingsGroup { SettingsRow(stringResource(R.string.settings_models_limits_unavailable)) }
                } else {
                    val unknownPlaceholder = stringResource(R.string.viewer_info_type_unknown)
                    val draft = drafts[selected] ?: (customLimitText(capability.contextWindow) to customLimitText(capability.maxTokens))
                    FormGroup {
                        NumberField(
                            draft.first, { drafts = drafts + (selected to (it to draft.second)) }, stringResource(R.string.settings_models_context_tokens),
                            placeholder = capability.contextWindow.value?.toString() ?: unknownPlaceholder,
                            supportingText = limitSource(capability.contextWindow.source).asString(), enabled = !writes.busy,
                        )
                        NumberField(
                            draft.second, { drafts = drafts + (selected to (draft.first to it)) }, stringResource(R.string.settings_models_max_output),
                            placeholder = capability.maxTokens.value?.toString() ?: unknownPlaceholder,
                            supportingText = limitSource(capability.maxTokens.source).asString(), enabled = !writes.busy,
                        )
                        FormButton(stringResource(R.string.settings_models_save_limits), enabled = !writes.busy && drafts.containsKey(selected), onClick = {
                            val (patch, message) = limitPatch(label(selected), draft.first, draft.second)
                            problem = message
                            if (patch != null) writes.run({ drafts = drafts - selected; data.reload() }) {
                                api.request("PUT", listOf("api", "settings", "models"), buildJsonObject {
                                    put("fast", buildJsonObject { put("model", loaded.fast) })
                                    put("standard", buildJsonObject { put("model", loaded.standard) })
                                    put("capabilities", buildJsonObject { put(selected, patch) })
                                })
                            }
                        })
                        FormButton(
                            stringResource(R.string.settings_models_clear_entered), primary = false,
                            enabled = !writes.busy && (capability.contextWindow.source == "custom" || capability.maxTokens.source == "custom"),
                            onClick = {
                                problem = null
                                writes.run({ drafts = drafts - selected; data.reload() }) {
                                    api.request("PUT", listOf("api", "settings", "models"), buildJsonObject {
                                        put("fast", buildJsonObject { put("model", loaded.fast) })
                                        put("standard", buildJsonObject { put("model", loaded.standard) })
                                        put("capabilities", buildJsonObject { put(selected, buildJsonObject { put("contextWindow", JsonNull); put("maxTokens", JsonNull) }) })
                                    })
                                }
                            },
                        )
                        val connection = connectionOf(selected)?.takeIf { it in loaded.customConnections }
                        if (connection != null) {
                            FormButton(stringResource(R.string.settings_models_scan_endpoint), primary = false, enabled = !writes.busy, onClick = {
                                scanStatus = null
                                writes.run({ data.reload() }) {
                                    val scanned = api.request("POST", listOf("api", "providers", connection, "limits", "scan"))
                                    val reported = (scanned["modelInfo"] as? JsonObject)?.size ?: 0
                                    scanStatus = if (reported > 0) {
                                        UiText.Plural(R.plurals.settings_models_scan_reported, reported, reported)
                                    } else {
                                        UiText.Resource(R.string.settings_models_scan_none)
                                    }
                                }
                            })
                            Text(
                                scanStatus?.asString() ?: stringResource(R.string.settings_models_scan_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
