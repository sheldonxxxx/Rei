package dev.rei.android.feature.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.obj
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Connectors: the apps agents can use through MCP. Add one by address (or from the short list), sign in or give it a token,
 * choose how careful each connector and each of its tools is, and remove it. [openId] opens one connector straight away
 * (a plugin's "Connection settings"); [fromPlugin] hides Remove, since a plugin's connections come and go with it.
 */
@Composable
fun ConnectorsScreen(api: ReiApi, onBack: () -> Unit, openId: String? = null, fromPlugin: Boolean = false) {
    var selected by rememberSaveable { mutableStateOf(openId) }
    BackHandler(selected != null && !(fromPlugin && selected == openId)) { selected = null }
    val id = selected
    if (id != null) {
        ConnectorDetail(api, id, canRemove = !fromPlugin, onBack = if (fromPlugin && id == openId) onBack else ({ selected = null }))
    } else {
        ConnectorList(api, onBack) { selected = it }
    }
}

@Composable
private fun ConnectorList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val writes = rememberWrites()
    val list = rememberResource(api) { connectorList(api.request("GET", listOf("api", "connectors"))) }
    var url by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var nameEdited by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var tokenHeader by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    fun add(body: JsonObject) {
        problem = null
        writes.run {
            val created = api.request("POST", listOf("api", "connectors"), body).obj("connector").connector()
            url = ""; name = ""; nameEdited = false; token = ""; tokenHeader = ""
            list.reload()
            onOpen(created.id)
        }
    }
    SubScreen("Connectors", onBack, busy = writes.busy || list.loading, error = problem ?: writes.error ?: list.error, onRetry = list::reload) {
        val loaded = list.value
        if (loaded != null) {
            SettingsGroup(title = "Your connectors") {
                if (loaded.isEmpty()) SettingsRow("No connectors yet.")
                loaded.forEachIndexed { index, item ->
                    SettingsRow(
                        item.name, icon = ReiIcons.Branch,
                        summary = listOfNotNull(
                            statusWord(item.status) + " · " + addressHost(item.url),
                            toolCountText(item.toolCount),
                            item.pluginName?.let { "Plugin: $it" + if (item.pluginEnabled) "" else " (disabled)" },
                            item.error.takeIf { item.status == "error" },
                        ).joinToString("\n"),
                        onClick = { onOpen(item.id) }, dividerBelow = index < loaded.lastIndex, trailing = { SettingsChevron() },
                    )
                }
            }
            SettingsGroup(title = "Browse connectors") {
                ConnectorCatalog.forEachIndexed { index, entry ->
                    val existing = loaded.firstOrNull { matchesCatalogUrl(it.url, entry) }
                    SettingsRow(
                        entry.name,
                        summary = listOfNotNull(entry.description, if (entry.preview) "Developer preview" else null, entry.id.takeIf { it == "gmail" }?.let { "Register ${api.serverUrl.trimEnd('/')}/api/mcp/oauth/callback as the redirect URI. Setup guide: ${entry.docsUrl}" }).joinToString("\n"),
                        onClick = if (existing != null) ({ onOpen(existing.id) }) else if (!writes.busy) ({ add(catalogBody(entry)) }) else null,
                        dividerBelow = index < ConnectorCatalog.lastIndex,
                        trailing = { if (existing != null) Text("Manage", color = MaterialTheme.colorScheme.primary) else Text("Set up", color = MaterialTheme.colorScheme.primary) },
                    )
                }
            }
            FormGroup(title = "Add a connector") {
                ReiTextField(
                    url, { url = it; if (!nameEdited) name = if (it.isBlank()) "" else nameFromUrl(it.trim()) }, "Address",
                    placeholder = "https://example.com/mcp", enabled = !writes.busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                ReiTextField(name, { name = it; nameEdited = true }, "Name", enabled = !writes.busy)
                SecretField(token, { token = it }, "Token (optional)", supportingText = "For a server that gives you a token instead of a sign-in page.", enabled = !writes.busy)
                if (token.isNotBlank()) {
                    ReiTextField(tokenHeader, { tokenHeader = it.take(128) }, "Token header name", placeholder = "Authorization", supportingText = "Leave blank to send the token as an Authorization bearer token.", enabled = !writes.busy)
                }
                FormButton("Add connector", enabled = !writes.busy && url.isNotBlank(), onClick = {
                    when (val created = connectorCreate(url, name, token, tokenHeader)) {
                        is ConnectorCreate.Invalid -> problem = created.message
                        is ConnectorCreate.Ready -> add(created.body)
                    }
                })
            }
        }
    }
}

@Composable
private fun ConnectorDetail(api: ReiApi, id: String, canRemove: Boolean, onBack: () -> Unit) {
    val writes = rememberWrites()
    val loaded = rememberResource(id) {
        connectorList(api.request("GET", listOf("api", "connectors"))).firstOrNull { it.id == id }
    }
    var connector by remember(loaded.value) { mutableStateOf(loaded.value) }
    var tools by remember { mutableStateOf<List<ConnectorTool>?>(null) }
    var toolsError by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var name by remember(connector?.name) { mutableStateOf(connector?.name.orEmpty()) }
    var token by remember { mutableStateOf("") }
    var tokenHeader by remember(connector?.tokenHeader) { mutableStateOf(connector?.tokenHeader.orEmpty()) }
    var confirmRemove by remember { mutableStateOf(false) }
    var confirmYolo by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<String?>(null) }
    val current = connector

    suspend fun loadTools(refresh: Boolean) {
        refreshing = refresh
        try {
            val body = api.request("GET", listOf("api", "connectors", id, "tools"), query = if (refresh) mapOf("refresh" to "1") else emptyMap())
            tools = toolList(body)
            toolsError = null
        } catch (failure: ReiApiException) {
            tools = null
            toolsError = if (failure.code == "needs_auth") "Sign in to see this connector's tools." else settingsError(failure)
        } finally {
            refreshing = false
        }
    }
    LaunchedEffect(current?.id, current?.status) {
        if (current?.status == "connected") loadTools(false)
        else toolsError = if (current?.status == "needs_auth") "Sign in to see this connector's tools." else null
    }

    fun patch(body: JsonObject, then: () -> Unit = {}) = writes.run(then) {
        connector = api.request("PATCH", listOf("api", "connectors", id), body).obj("connector").connector()
    }

    SubScreen(current?.name ?: "Connector", onBack, busy = writes.busy || loaded.loading || refreshing, error = writes.error ?: loaded.error, onRetry = loaded::reload) {
        notice?.let { StatusBanner(it) }
        if (current == null) {
            if (!loaded.loading && loaded.error == null) EmptyState(ReiIcons.Branch, "That connector no longer exists")
        } else {
            SettingsGroup(title = "Status") {
                SettingsRow(
                    if (current.auth == "token" && current.status == "needs_auth") "Token rejected" else statusText(current),
                    summary = listOfNotNull(addressHost(current.url), current.pluginName?.let { "Part of the plugin $it" + if (current.pluginEnabled) "" else " (disabled)" } ?: "Standalone: no plugin owns it").joinToString("\n"),
                )
            }
            FormGroup(title = "Name") {
                ReiTextField(name, { name = it.take(80) }, "Connector name", enabled = !writes.busy)
                FormButton("Save name", primary = false, enabled = !writes.busy && name.isNotBlank() && name.trim() != current.name, onClick = {
                    patch(buildJsonObject { put("name", name.trim()) })
                })
            }
            if (current.status == "needs_auth" && current.auth != "token") {
                ConnectorSignIn(api, id, busy = writes.busy) { signedIn ->
                    connector = signedIn
                    notice = "Signed in to ${signedIn.name}."
                    loaded.reload()
                }
            }
            if (current.auth == "token") {
                FormGroup(title = "Token authentication", note = current.error.takeIf { current.status == "needs_auth" }) {
                    SecretField(token, { token = it }, "Token", placeholder = "Leave blank to keep the saved token", enabled = !writes.busy)
                    ReiTextField(tokenHeader, { tokenHeader = it.take(128) }, "Token header name", placeholder = "Authorization", supportingText = "Leave blank to send the token as an Authorization bearer token.", enabled = !writes.busy)
                    val body = authenticationBody(current, token, tokenHeader)
                    FormButton("Save authentication", enabled = !writes.busy && body != null, onClick = {
                        if (body != null) {
                            patch(body) { token = ""; tools = null }
                        }
                    })
                }
            }
            SettingsGroup(title = "Permissions") {
                ChoiceRow(
                    "MCP permission profile", current.mcpProfile ?: "always_ask", McpProfiles, icon = ReiIcons.Shield,
                    summary = "Chat permissions do not change this profile. A provider can mislabel a tool.",
                    enabled = !writes.busy && current.canSetProfile(), dividerBelow = true,
                    onSelect = { choice ->
                        if (choice == "yolo") confirmYolo = true
                        else writes.run { connector = api.request("PUT", listOf("api", "connectors", id, "profile"), profileBody(choice, current, false)).obj("connector").connector() }
                    },
                )
                SettingsSwitchRow(
                    "Holds my data", current.holdsPrivate, { on -> patch(buildJsonObject { put("holdsPrivate", on) }) },
                    summary = "Reading from it marks the chat as having read your private data, so sending things out asks first.", enabled = !writes.busy,
                )
            }
            SettingsGroup(title = "Tools") {
                SettingsRow(
                    "These are effect classes, not permissions. A manual Read downgrade never makes an unmarked tool automatic in Read-only; the profile decides which calls need approval.",
                )
                toolsError?.let { SettingsRow(it, destructive = true) }
                val list = tools
                if (list != null && list.isEmpty()) SettingsRow("This connector has no tools.")
                list?.forEachIndexed { index, tool ->
                    ChoiceRow(
                        tool.name, tool.current.wire,
                        ToolClass.entries.map { Choice(it.wire, it.label + if (it == tool.defaultClass) " (default)" else "") },
                        summary = tool.description.takeIf { it.isNotBlank() }?.lineSequence()?.firstOrNull()?.take(160),
                        enabled = !writes.busy && !tool.locked, dividerBelow = true,
                        onSelect = { wire ->
                            val chosen = ToolClass.fromWire(wire) ?: return@ChoiceRow
                            val value = overrideFor(tool, chosen)
                            writes.run {
                                api.request("PUT", listOf("api", "connectors", id, "tools", tool.name), toolClassBody(tool, value))
                                tools = tools?.map { if (it.name == tool.name) it.withOverride(value) else it }
                            }
                        },
                    )
                    if (tool.override != null) {
                        SettingsRow("Reset ${tool.name} to ${tool.defaultClass.label}", dividerBelow = index < list.lastIndex, onClick = {
                            writes.run { api.request("PUT", listOf("api", "connectors", id, "tools", tool.name), toolClassBody(tool, null)); tools = tools?.map { if (it.name == tool.name) it.withOverride(null) else it } }
                        })
                    }
                }
            }
            FormGroup {
                FormButton("Refresh tools", primary = false, enabled = !writes.busy && !refreshing && current.status == "connected", onClick = {
                    writes.run { loadTools(true) }
                })
                if (canRemove) FormButton("Remove connector", primary = false, enabled = !writes.busy, onClick = { confirmRemove = true })
            }
        }
    }
    if (confirmRemove && current != null) {
        ConfirmDialog(
            title = "Remove this connector?",
            text = "“${current.name}” is signed out and forgotten, and the permissions you gave for its tools end. You can add it again later.",
            confirmLabel = "Remove", destructive = true,
            onConfirm = {
                confirmRemove = false
                writes.run(onBack) {
                    try {
                        api.request("DELETE", listOf("api", "connectors", id))
                    } catch (failure: ReiApiException) {
                        if (failure.code != "not_found" && failure.code != "connector_not_found") throw failure
                    }
                }
            },
            onDismiss = { confirmRemove = false },
        )
    }
    if (confirmYolo && current != null) {
        ConfirmDialog(
            title = "Enable YOLO for this connector?",
            text = "All MCP tools may run without asking, including writes, messages and irreversible deletion. Data can be permanently lost or sent outside your control. Chat permissions and trigger allowlists will not add prompts. Enable this only if you accept those risks.",
            confirmLabel = "Enable YOLO", destructive = true,
            onConfirm = {
                confirmYolo = false
                writes.run { connector = api.request("PUT", listOf("api", "connectors", id, "profile"), profileBody("yolo", current, true)).obj("connector").connector() }
            },
            onDismiss = { confirmYolo = false },
        )
    }
}

/**
 * Signs a connector in. The provider's consent page opens in the system browser (a Custom Tab): it is the provider's own page
 * and must be seen there. The provider then sends the browser to the server's callback; the app takes the address that page
 * ends on, pasted by the user, and the gateway checks the state and exchanges the code. A server that cannot register a client
 * by itself first asks for a client ID.
 */
@Composable
private fun ConnectorSignIn(api: ReiApi, connectorId: String, busy: Boolean, onSignedIn: (Connector) -> Unit) {
    val context = LocalContext.current
    val writes = rememberWrites()
    var needsClient by remember { mutableStateOf(false) }
    var clientId by remember { mutableStateOf("") }
    var clientSecret by remember { mutableStateOf("") }
    var started by remember { mutableStateOf(false) }
    var pasted by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val working = busy || writes.busy
    fun start(body: JsonObject) {
        problem = null
        writes.run {
            try {
                val url = api.request("POST", listOf("api", "connectors", connectorId, "oauth", "start"), body).let { it["authorizationUrl"]?.let { value -> value.jsonPrimitive.content } }.orEmpty()
                needsClient = false
                started = true
                if (!openInBrowser(context, url)) problem = "No browser could open the sign-in page."
            } catch (failure: ReiApiException) {
                if (failure.code == "client_id_required") needsClient = true else throw failure
            }
        }
    }
    FormGroup(title = "Sign in", note = problem) {
        if (needsClient) {
            Text("This server can't set up sign-in by itself. Enter the client ID from its developer settings.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ReiTextField(clientId, { clientId = it }, "Client ID", enabled = !working)
            SecretField(clientSecret, { clientSecret = it }, "Client secret (if it has one)", enabled = !working)
            FormButton("Continue to sign in", enabled = !working && clientId.isNotBlank(), onClick = { start(clientIdBody(clientId, clientSecret)); clientSecret = "" })
        } else {
            FormButton(if (started) "Open the sign-in page again" else "Sign in", primary = !started, enabled = !working, onClick = { start(clientIdBody("", "")) })
            if (started) {
                Text(
                    "Finish signing in in your browser. When it ends on the Rei page, copy that page's full address (it contains state= and code=) and paste it here.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                ReiTextField(pasted, { pasted = it }, "Address after sign-in", placeholder = "https://…/settings/connectors?state=…&code=…", enabled = !working)
                FormButton("Finish sign-in", enabled = !working && pasted.isNotBlank(), onClick = {
                    when (val result = signInReturn(pasted)) {
                        is SignInReturn.Code -> {
                            problem = null
                            writes.run({ pasted = "" }) {
                                onSignedIn(api.request("POST", listOf("api", "connectors", "oauth", "finish"), finishBody(result)).obj("connector").connector())
                            }
                        }
                        is SignInReturn.Failed -> problem = "Sign-in didn't complete: ${result.reason}"
                        SignInReturn.None -> problem = "That address has no sign-in code. Copy the whole address from the page the sign-in ended on."
                    }
                })
            }
        }
    }
}
