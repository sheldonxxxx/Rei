package dev.rei.android.feature.settings

import androidx.activity.compose.BackHandler
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import dev.rei.android.data.ReiApi
import dev.rei.android.data.string
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

private enum class ProviderSection(val title: String) { Chat("Chat providers"), Embeddings("Embeddings"), Search("Web search") }

/**
 * Providers: where models come from. Chat connections, the embedding connection that Memory search uses, and the web search
 * providers, each its own screen. Keys and tokens are write-only: they travel in the request that saves them and are never
 * shown again.
 */
@Composable
fun ProvidersScreen(api: ReiApi, onBack: () -> Unit) {
    var section by rememberSaveable { mutableStateOf<ProviderSection?>(null) }
    BackHandler(section != null) { section = null }
    when (section) {
        ProviderSection.Chat -> ChatProvidersScreen(api) { section = null }
        ProviderSection.Embeddings -> EmbeddingScreen(api) { section = null }
        ProviderSection.Search -> SearchProvidersScreen(api) { section = null }
        null -> SubScreen("Providers", onBack) {
            SettingsGroup {
                SettingsRow("Chat providers", icon = ReiIcons.Globe, summary = "Connect OpenAI or a custom endpoint, then pick models under Models.", onClick = { section = ProviderSection.Chat }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Embeddings", icon = ReiIcons.Memory, summary = "How Memory search finds related notes.", onClick = { section = ProviderSection.Embeddings }, dividerBelow = true, trailing = { SettingsChevron() })
                SettingsRow("Web search", icon = ReiIcons.Search, summary = "Which search providers agents try, in order.", onClick = { section = ProviderSection.Search }, trailing = { SettingsChevron() })
            }
        }
    }
}

@Composable
private fun ChatProvidersScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val rows = rememberResource(api) { providerRows(api.request("GET", listOf("api", "providers"))) }
    // null: the list; otherwise the form being edited (a new connection or a saved one).
    var form by remember { mutableStateOf<ProviderForm?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<ProviderRow?>(null) }
    BackHandler(form != null) { form = null }
    val current = form
    if (current != null) {
        ProviderEditor(api, current, { form = it }, rows::reload, { notice = it }) { form = null }
    } else {
        SubScreen("Chat providers", onBack, busy = writes.busy || rows.loading, error = writes.error ?: rows.error, onRetry = rows::reload) {
            notice?.let { StatusBanner(it, kind = StatusKind.Info) }
            val loaded = rows.value
            if (loaded != null) {
                SettingsGroup(title = "Connections") {
                    if (loaded.isEmpty()) SettingsRow("No providers connected yet.")
                    loaded.forEachIndexed { index, row ->
                        SettingsRow(
                            row.name,
                            summary = listOf(providerSubtitle(row), if (row.connected) "Connected" else "Needs setup").filter { it.isNotEmpty() }.joinToString("\n"),
                            onClick = { notice = null; form = editProviderForm(row) },
                            dividerBelow = index < loaded.lastIndex,
                            trailing = { ReiIconButton(ReiIcons.Trash, "Remove ${row.name}", { removing = row }) },
                        )
                    }
                }
                SettingsGroup {
                    SettingsRow("Add OpenAI", icon = ReiIcons.Plus, onClick = { notice = null; form = newProviderForm(KindOpenAi) }, dividerBelow = true)
                    SettingsRow("Add a custom endpoint", icon = ReiIcons.Plus, summary = "Any OpenAI-compatible server.", onClick = { notice = null; form = newProviderForm(KindCustom) })
                }
            }
        }
    }
    removing?.let { row ->
        ConfirmDialog(
            title = "Remove ${row.name}?",
            text = "Agents that use its models switch to another available model.",
            confirmLabel = "Remove",
            destructive = true,
            onConfirm = {
                removing = null
                writes.run(rows::reload) { api.request("DELETE", listOf("api", "providers", row.id)) }
            },
            onDismiss = { removing = null },
        )
    }
}

/** Add or edit one connection. The API key field starts empty and is cleared once the save request has gone out. */
@Composable
private fun ProviderEditor(
    api: ReiApi,
    form: ProviderForm,
    onForm: (ProviderForm) -> Unit,
    onSaved: () -> Unit,
    onNotice: (String?) -> Unit,
    onClose: () -> Unit,
) {
    val writes = rememberWrites()
    var problem by remember { mutableStateOf<String?>(null) }
    var scanned by remember { mutableStateOf<String?>(null) }
    var newModel by remember { mutableStateOf("") }
    val busy = writes.busy
    val title = if (form.editingId == null) "Add provider" else "Edit provider"
    SubScreen(title, onClose, busy = busy, error = problem ?: writes.error) {
        FormGroup(title = "Provider") {
            if (form.editingId == null) {
                ChoiceRow(
                    "Provider", form.kind,
                    listOf(Choice(KindOpenAi, "OpenAI"), Choice(KindCustom, "Custom OpenAI-compatible endpoint")),
                    onSelect = { onForm(newProviderForm(it)); problem = null; scanned = null }, enabled = !busy,
                )
            }
            ReiTextField(form.name, { onForm(form.copy(name = it.take(MaxProviderName))) }, "Name", enabled = !busy)
        }
        if (form.kind == KindOpenAi) {
            SettingsGroup(title = "Sign-in") {
                ChoiceRow(
                    "Sign-in method", form.auth,
                    listOf(Choice(AuthOAuth, "Use ChatGPT subscription"), Choice(AuthApiKey, "OpenAI API key")),
                    onSelect = { onForm(form.copy(auth = it, apiKey = "")) }, enabled = !busy,
                )
            }
        }
        if (form.usesOAuth()) {
            ChatGptSignIn(api, busy = busy, onSettled = { onSaved(); onClose() })
        } else {
            FormGroup(title = if (form.kind == KindOpenAi) "API key" else "Endpoint") {
                if (form.kind == KindCustom) {
                    ReiTextField(
                        form.baseUrl, { onForm(form.copy(baseUrl = it)); scanned = null }, "Base URL", placeholder = "https://api.example.com/v1",
                        supportingText = "HTTPS endpoints are supported. HTTP works for localhost and host.docker.internal.", enabled = !busy,
                    )
                    ChoiceRow(
                        "API", form.api,
                        listOf(Choice("chat", "Chat Completions"), Choice("responses", "Responses", "Only if the endpoint supports /responses.")),
                        onSelect = { onForm(form.copy(api = it)) }, enabled = !busy,
                    )
                }
                SecretField(
                    form.apiKey, { onForm(form.copy(apiKey = it)) },
                    if (form.kind == KindOpenAi) "OpenAI API key" else "API key (optional)",
                    supportingText = when {
                        form.editingId != null && form.originalAuth == AuthApiKey -> "Leave blank to keep the current key."
                        form.editingId != null && form.kind == KindOpenAi -> "Enter an API key to switch from ChatGPT sign-in."
                        else -> "Stored by the gateway. It is never shown again."
                    },
                    enabled = !busy,
                )
            }
            if (form.kind == KindCustom) {
                FormGroup(title = "Models", note = "Scan after entering your URL and key, or type model IDs. Requests use ${if (form.api == "responses") "Responses" else "Chat Completions"}.") {
                    form.models.forEach { model ->
                        SettingsRow(model, dividerBelow = false, trailing = { ReiIconButton(ReiIcons.Close, "Remove $model", { onForm(form.copy(models = form.models - model)) }) })
                    }
                    ReiTextField(newModel, { newModel = it }, "Add a model ID", placeholder = "model-name", enabled = !busy)
                    FormButton("Add model", primary = false, enabled = !busy && newModel.isNotBlank(), onClick = {
                        onForm(form.copy(models = addModelId(form.models, newModel))); newModel = ""
                    })
                    FormButton("Scan models", primary = false, enabled = !busy && form.baseUrl.isNotBlank(), onClick = {
                        problem = null; scanned = null
                        writes.run {
                            val result = api.request("POST", listOf("api", "providers", "scan"), scanBody(form))
                            val ids = (result["models"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
                            onForm(form.copy(models = ids, modelInfo = result["modelInfo"] as? JsonObject))
                            scanned = scanSummary(ids)
                        }
                    })
                    scanned?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            FormGroup {
                FormButton(if (form.editingId == null) "Save connection" else "Save changes", enabled = !busy, onClick = {
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
    var problem by remember { mutableStateOf<String?>(null) }
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
            if (next.error != null) problem = next.error
            if (!next.pending && next.error == null) onSettled()
        }
    }
    val working = busy || writes.busy
    FormGroup(title = "ChatGPT sign-in", note = problem ?: writes.error) {
        if (!pending) {
            FormButton("Use ChatGPT subscription", enabled = !working, onClick = { explain = true })
        } else {
            status?.authorizationUrl?.let { url -> FormButton("Open the OpenAI sign-in page", primary = false, enabled = !working, onClick = { if (!openInBrowser(context, url)) problem = "No browser could open the sign-in page." }) }
            Text(
                "Complete sign-in in your browser. If it ends on a page that cannot connect, copy that page's full address and paste it below.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ReiTextField(redirect, { redirect = it }, "Redirect URL", placeholder = "http://127.0.0.1:1455/auth/callback?...", enabled = !working)
            FormButton("Finish sign-in", enabled = !working && redirectUrlOrNull(redirect) != null, onClick = {
                val address = redirectUrlOrNull(redirect) ?: return@FormButton
                problem = null
                writes.run({ redirect = "" }) { api.request("POST", listOf("api", "providers", "openai", "oauth", "callback"), buildJsonObject { put("url", address) }) }
            })
            FormButton("Cancel sign-in", primary = false, enabled = !working, onClick = {
                problem = null
                writes.run({ redirect = ""; status = OAuthStatus(false, null, null) }) { api.request("DELETE", listOf("api", "providers", "openai", "oauth")) }
            })
        }
    }
    if (explain) {
        ConfirmDialog(
            title = "Before you sign in",
            text = "Continue opens ChatGPT in your browser. Sign in there. If the final page cannot connect, copy its full address, including the question mark and everything after it, and paste it into Redirect URL here. If sign-in returns by itself, Rei finishes connecting in the background.",
            confirmLabel = "Continue to ChatGPT",
            onConfirm = {
                explain = false
                problem = null
                writes.run {
                    val started = api.request("POST", listOf("api", "providers", "openai", "oauth", "start"))
                    val url = started.string("authorizationUrl")
                    status = OAuthStatus(true, url, null)
                    if (!openInBrowser(context, url)) problem = "No browser could open the sign-in page."
                }
            },
            onDismiss = { explain = false },
        )
    }
}
