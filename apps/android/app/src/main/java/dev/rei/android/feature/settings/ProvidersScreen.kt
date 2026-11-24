package dev.rei.android.feature.settings

import androidx.annotation.Keep
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.annotation.StringRes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Keep
@kotlinx.serialization.Serializable
enum class ProviderSection(@StringRes val titleRes: Int) {
    Chat(R.string.settings_providers_section_chat),
    Embeddings(R.string.settings_providers_section_embeddings),
    Search(R.string.settings_providers_section_search),
}

/**
 * Providers: where models come from. Chat connections, the embedding connection that Memory search uses, and the web search
 * providers, each its own screen. Keys and tokens are write-only: they travel in the request that saves them and are never
 * shown again.
 */
@Composable
fun ProvidersScreen(onOpenSection: (ProviderSection) -> Unit, onBack: () -> Unit) {
    SubScreen(stringResource(R.string.settings_page_providers), onBack) {
        SettingsGroup {
            SettingsRow(stringResource(R.string.settings_providers_section_chat), icon = ReiIcons.Globe, summary = stringResource(R.string.settings_providers_chat_summary), onClick = { onOpenSection(ProviderSection.Chat) }, dividerBelow = true, trailing = { SettingsChevron() })
            SettingsRow(stringResource(R.string.settings_providers_section_embeddings), icon = ReiIcons.Memory, summary = stringResource(R.string.settings_providers_embeddings_summary), onClick = { onOpenSection(ProviderSection.Embeddings) }, dividerBelow = true, trailing = { SettingsChevron() })
            SettingsRow(stringResource(R.string.settings_providers_section_search), icon = ReiIcons.Search, summary = stringResource(R.string.settings_providers_search_summary), onClick = { onOpenSection(ProviderSection.Search) }, trailing = { SettingsChevron() })
        }
    }
}

@Composable
fun ChatProvidersScreen(api: ReiApi, onOpenForm: (kind: String, editingId: String?) -> Unit, onBack: () -> Unit) {
    val writes = rememberWrites()
    val rows = rememberResource(api) { providerRows(api.request("GET", listOf("api", "providers"))) }
    var removing by remember { mutableStateOf<ProviderRow?>(null) }
    SubScreen(stringResource(R.string.settings_providers_section_chat), onBack, busy = writes.busy || rows.loading, error = writes.error ?: rows.error, onRetry = rows::reload) {
        val loaded = rows.value
        if (loaded != null) {
            SettingsGroup(title = stringResource(R.string.settings_providers_connections)) {
                if (loaded.isEmpty()) SettingsRow(stringResource(R.string.settings_providers_none))
                loaded.forEachIndexed { index, row ->
                    SettingsRow(
                        row.name,
                        summary = listOf(
                            providerSubtitle(row).asString(),
                            stringResource(if (row.connected) R.string.settings_providers_connected else R.string.settings_providers_needs_setup),
                        ).filter { it.isNotEmpty() }.joinToString("\n"),
                        onClick = { onOpenForm(row.kind, row.id) },
                        dividerBelow = index < loaded.lastIndex,
                        trailing = { ReiIconButton(ReiIcons.Trash, stringResource(R.string.settings_providers_remove_cd, row.name), { removing = row }) },
                    )
                }
            }
            SettingsGroup {
                SettingsRow(stringResource(R.string.settings_providers_add_openai), icon = ReiIcons.Plus, onClick = { onOpenForm(KindOpenAi, null) }, dividerBelow = true)
                SettingsRow(stringResource(R.string.settings_providers_add_custom), icon = ReiIcons.Plus, summary = stringResource(R.string.settings_providers_add_custom_summary), onClick = { onOpenForm(KindCustom, null) })
            }
        }
    }
    removing?.let { row ->
        ConfirmDialog(
            title = stringResource(R.string.settings_providers_remove_title, row.name),
            text = stringResource(R.string.settings_providers_remove_body),
            confirmLabel = stringResource(R.string.settings_passkeys_remove),
            destructive = true,
            onConfirm = {
                removing = null
                writes.run(rows::reload) { api.request("DELETE", listOf("api", "providers", row.id)) }
            },
            onDismiss = { removing = null },
        )
    }
}

@Composable
fun ProviderEditorScreen(api: ReiApi, kind: String, editingId: String?, onClose: () -> Unit) {
    val context = LocalContext.current
    val notices = LocalNotices.current
    val initialRow = rememberResource(editingId) {
        if (editingId == null) null
        else providerRows(api.request("GET", listOf("api", "providers"))).firstOrNull { it.id == editingId }
    }
    val customDefault = stringResource(R.string.settings_providers_default_custom_name)
    var form by rememberSettingsState<ProviderForm?> {
        if (editingId == null) newProviderForm(kind, customDefault) else null
    }
    val row = initialRow.value
    LaunchedEffect(row) {
        if (form == null && row != null) form = editProviderForm(row)
    }
    val current = form
    if (current == null) {
        SubScreen(stringResource(if (editingId == null) R.string.settings_providers_add_title else R.string.settings_providers_edit_title), onClose, busy = initialRow.loading, error = initialRow.error, onRetry = initialRow::reload) {}
        return
    }
    ProviderEditor(
        api = api,
        form = current,
        onForm = { form = it },
        onSaved = {},
        onNotice = { msg -> msg?.let { notices?.show(it.asString(context)) } },
        onClose = onClose,
    )
}

/** Add or edit one connection. The API key field starts empty and is cleared once the save request has gone out. */
@Composable
private fun ProviderEditor(
    api: ReiApi,
    form: ProviderForm,
    onForm: (ProviderForm) -> Unit,
    onSaved: () -> Unit,
    onNotice: (UiText?) -> Unit,
    onClose: () -> Unit,
) {
    val customDefault = stringResource(R.string.settings_providers_default_custom_name)
    val writes = rememberWrites()
    var problem by remember { mutableStateOf<UiText?>(null) }
    var scanned by remember { mutableStateOf<UiText?>(null) }
    var newModel by remember { mutableStateOf("") }
    val busy = writes.busy
    val title = stringResource(if (form.editingId == null) R.string.settings_providers_add_title else R.string.settings_providers_edit_title)
    SubScreen(title, onClose, busy = busy, error = problem ?: writes.error) {
        FormGroup(title = stringResource(R.string.settings_providers_group_provider)) {
            if (form.editingId == null) {
                ChoiceRow(
                    stringResource(R.string.settings_providers_group_provider), form.kind,
                    listOf(
                        Choice(KindOpenAi, UiText.Resource(R.string.settings_providers_choice_openai)),
                        Choice(KindCustom, UiText.Resource(R.string.settings_providers_choice_custom)),
                    ),
                    onSelect = { onForm(newProviderForm(it, customDefault)); problem = null; scanned = null }, enabled = !busy,
                )
            }
            ReiTextField(form.name, { onForm(form.copy(name = it.take(MaxProviderName))) }, stringResource(R.string.settings_triggers_name_label), enabled = !busy)
        }
        if (form.kind == KindOpenAi) {
            SettingsGroup(title = stringResource(R.string.settings_providers_sign_in_group)) {
                ChoiceRow(
                    stringResource(R.string.settings_providers_sign_in_method), form.auth,
                    listOf(
                        Choice(AuthOAuth, UiText.Resource(R.string.settings_providers_use_chatgpt)),
                        Choice(AuthApiKey, UiText.Resource(R.string.settings_providers_openai_api_key)),
                    ),
                    onSelect = { onForm(form.copy(auth = it, apiKey = "")) }, enabled = !busy,
                )
            }
        }
        if (form.usesOAuth()) {
            ChatGptSignIn(api, busy = busy, onSettled = { onSaved(); onClose() })
        } else {
            FormGroup(title = stringResource(if (form.kind == KindOpenAi) R.string.settings_providers_auth_api_key else R.string.settings_providers_endpoint_group)) {
                if (form.kind == KindCustom) {
                    ReiTextField(
                        form.baseUrl, { onForm(form.copy(baseUrl = it)); scanned = null }, stringResource(R.string.settings_providers_base_url),
                        placeholder = stringResource(R.string.settings_providers_base_url_placeholder),
                        supportingText = stringResource(R.string.settings_providers_base_url_hint), enabled = !busy,
                    )
                    ChoiceRow(
                        stringResource(R.string.settings_providers_api_label), form.api,
                        listOf(
                            Choice("chat", UiText.Resource(R.string.settings_providers_api_chat)),
                            Choice("responses", UiText.Resource(R.string.settings_providers_api_responses), UiText.Resource(R.string.settings_providers_api_responses_hint)),
                        ),
                        onSelect = { onForm(form.copy(api = it)) }, enabled = !busy,
                    )
                }
                SecretField(
                    form.apiKey, { onForm(form.copy(apiKey = it)) },
                    stringResource(if (form.kind == KindOpenAi) R.string.settings_providers_openai_api_key else R.string.settings_providers_api_key_optional),
                    supportingText = stringResource(
                        when {
                            form.editingId != null && form.originalAuth == AuthApiKey -> R.string.settings_providers_api_key_keep
                            form.editingId != null && form.kind == KindOpenAi -> R.string.settings_providers_api_key_switch
                            else -> R.string.settings_providers_api_key_stored
                        },
                    ),
                    enabled = !busy,
                )
            }
            if (form.kind == KindCustom) {
                val apiLabel = stringResource(if (form.api == "responses") R.string.settings_providers_api_responses else R.string.settings_providers_api_chat)
                FormGroup(title = stringResource(R.string.settings_page_models), note = stringResource(R.string.settings_providers_models_note, apiLabel)) {
                    form.models.forEach { model ->
                        SettingsRow(model, dividerBelow = false, trailing = { ReiIconButton(ReiIcons.Close, stringResource(R.string.settings_providers_remove_cd, model), { onForm(form.copy(models = form.models - model)) }) })
                    }
                    ReiTextField(newModel, { newModel = it }, stringResource(R.string.settings_providers_add_model_id), placeholder = stringResource(R.string.settings_providers_model_id_placeholder), enabled = !busy)
                    FormButton(stringResource(R.string.settings_providers_add_model), primary = false, enabled = !busy && newModel.isNotBlank(), onClick = {
                        onForm(form.copy(models = addModelId(form.models, newModel))); newModel = ""
                    })
                    FormButton(stringResource(R.string.settings_providers_scan_models), primary = false, enabled = !busy && form.baseUrl.isNotBlank(), onClick = {
                        problem = null; scanned = null
                        writes.run {
                            val result = api.request("POST", listOf("api", "providers", "scan"), scanBody(form))
                            val ids = (result["models"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
                            onForm(form.copy(models = ids, modelInfo = result["modelInfo"] as? JsonObject))
                            scanned = scanSummary(ids)
                        }
                    })
                    scanned?.let { Text(it.asString(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            FormGroup {
                FormButton(stringResource(if (form.editingId == null) R.string.settings_providers_save_connection else R.string.settings_providers_save_changes), enabled = !busy, onClick = {
                    when (val save = providerSave(form)) {
                        is ProviderSave.Invalid -> problem = save.message
                        is ProviderSave.Ready -> {
                            problem = null
                            writes.run({ onSaved(); onClose() }) {
                                val saved = api.request("POST", listOf("api", "providers"), save.body)
                                onNotice(replacedNotice(saved))
                            }
                        }
                    }
                })
            }
        }
    }
}

/**
 * The ChatGPT sign-in step. The sign-in page has to open in the system browser (a Custom Tab): it is the provider's own
 * consent page. Rei then waits for the gateway to finish, or takes the redirect address the user pastes when the browser
 * could not reach the server's local callback.
 */
@Composable
private fun ChatGptSignIn(api: ReiApi, busy: Boolean, onSettled: () -> Unit) {
    val context = LocalContext.current
    val writes = rememberWrites()
    var status by remember { mutableStateOf<OAuthStatus?>(null) }
    var redirect by remember { mutableStateOf("") }
    var explain by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<UiText?>(null) }
    val pending = status?.pending == true
    suspend fun fetch(): OAuthStatus? = try {
        oauthStatus(api.request("GET", listOf("api", "providers", "openai", "oauth", "status")))
    } catch (failure: CancellationException) {
        throw failure
    } catch (failure: Exception) {
        problem = settingsError(failure)
        null
    }
    // Resume an attempt the gateway already holds.
    LaunchedEffect(Unit) { status = fetch() }
    // While one is pending, follow it once a second. It ends when the gateway finishes it (the connection is saved), fails or
    // is cancelled; a failure stays on screen.
    LaunchedEffect(pending) {
        while (pending) {
            delay(1000)
            val next = fetch() ?: continue
            status = next
            if (next.error != null) problem = UiText.Literal(next.error)
            if (!next.pending && next.error == null) onSettled()
        }
    }
    val working = busy || writes.busy
    FormGroup(title = stringResource(R.string.settings_providers_oauth_title), note = (problem ?: writes.error)?.asString()) {
        if (!pending) {
            FormButton(stringResource(R.string.settings_providers_use_chatgpt), enabled = !working, onClick = { explain = true })
        } else {
            status?.authorizationUrl?.let { url ->
                FormButton(stringResource(R.string.settings_providers_oauth_open), primary = false, enabled = !working, onClick = {
                    if (!openInBrowser(context, url)) problem = UiText.Resource(R.string.settings_providers_oauth_no_browser)
                })
            }
            Text(
                stringResource(R.string.settings_providers_oauth_instructions),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ReiTextField(redirect, { redirect = it }, stringResource(R.string.settings_providers_oauth_redirect_label), placeholder = stringResource(R.string.settings_providers_oauth_redirect_placeholder), enabled = !working)
            FormButton(stringResource(R.string.settings_providers_oauth_finish), enabled = !working && redirectUrlOrNull(redirect) != null, onClick = {
                val address = redirectUrlOrNull(redirect) ?: return@FormButton
                problem = null
                writes.run({ redirect = "" }) { api.request("POST", listOf("api", "providers", "openai", "oauth", "callback"), buildJsonObject { put("url", address) }) }
            })
            FormButton(stringResource(R.string.settings_providers_oauth_cancel), primary = false, enabled = !working, onClick = {
                problem = null
                writes.run({ redirect = ""; status = OAuthStatus(false, null, null) }) { api.request("DELETE", listOf("api", "providers", "openai", "oauth")) }
            })
        }
    }
    if (explain) {
        ConfirmDialog(
            title = stringResource(R.string.settings_providers_oauth_explain_title),
            text = stringResource(R.string.settings_providers_oauth_explain_body),
            confirmLabel = stringResource(R.string.settings_providers_oauth_continue),
            onConfirm = {
                explain = false
                problem = null
                writes.run {
                    val started = api.request("POST", listOf("api", "providers", "openai", "oauth", "start"))
                    val url = started.string("authorizationUrl")
                    status = OAuthStatus(true, url, null)
                    if (!openInBrowser(context, url)) problem = UiText.Resource(R.string.settings_providers_oauth_no_browser)
                }
            },
            onDismiss = { explain = false },
        )
    }
}
