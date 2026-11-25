package dev.rei.android.feature.settings

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.obj
import dev.rei.android.ui.UiText
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
fun ConnectorsScreen(api: ReiApi, onOpenConnector: (String) -> Unit, onBack: () -> Unit) {
    ConnectorList(api, onBack, onOpenConnector)
}

@Composable
private fun ConnectorList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val writes = rememberWrites()
    val list = rememberResource("connectors.list", api) { connectorList(api.request("GET", listOf("api", "connectors"))) }
    var url by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var nameEdited by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var tokenHeader by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<UiText?>(null) }
    fun add(body: JsonObject) {
        problem = null
        writes.run {
            val created = api.request("POST", listOf("api", "connectors"), body).obj("connector").connector()
            url = ""; name = ""; nameEdited = false; token = ""; tokenHeader = ""
            list.reload()
            onOpen(created.id)
        }
    }
    SubScreen(stringResource(R.string.settings_page_connectors), onBack, busy = writes.busy || list.loading, error = problem ?: writes.error ?: list.error, onRetry = list::reload) {
        val loaded = list.value
        if (loaded != null) {
            SettingsGroup(title = stringResource(R.string.settings_conn_your_group)) {
                if (loaded.isEmpty()) SettingsRow(stringResource(R.string.settings_conn_none))
                loaded.forEachIndexed { index, item ->
                    SettingsRow(
                        item.name, icon = ReiIcons.Branch,
                        summary = listOfNotNull(
                            stringResource(R.string.settings_conn_summary_host, statusWord(item.status).asString(), addressHost(item.url)),
                            toolCountText(item.toolCount).asString(),
                            item.pluginName?.let {
                                stringResource(if (item.pluginEnabled) R.string.settings_conn_plugin_part else R.string.settings_conn_plugin_disabled, it)
                            },
                            item.error.takeIf { item.status == "error" },
                        ).joinToString("\n"),
                        onClick = { onOpen(item.id) }, dividerBelow = index < loaded.lastIndex, trailing = { SettingsChevron() },
                    )
                }
            }
            SettingsGroup(title = stringResource(R.string.settings_conn_browse_group)) {
                ConnectorCatalog.forEachIndexed { index, entry ->
                    val existing = loaded.firstOrNull { matchesCatalogUrl(it.url, entry) }
                    SettingsRow(
                        entry.name,
                        summary = listOfNotNull(
                            stringResource(entry.descriptionRes),
                            if (entry.preview) stringResource(R.string.settings_conn_dev_preview) else null,
                            entry.id.takeIf { it == "gmail" }?.let { stringResource(R.string.settings_conn_gmail_hint, api.serverUrl.trimEnd('/'), entry.docsUrl) },
                        ).joinToString("\n"),
                        onClick = if (existing != null) ({ onOpen(existing.id) }) else if (!writes.busy) ({ add(catalogBody(entry)) }) else null,
                        dividerBelow = index < ConnectorCatalog.lastIndex,
                        trailing = { Text(stringResource(if (existing != null) R.string.settings_conn_manage else R.string.settings_conn_setup), color = MaterialTheme.colorScheme.primary) },
                    )
                }
            }
            FormGroup(title = stringResource(R.string.settings_conn_add_group)) {
                ReiTextField(
                    url, { url = it; if (!nameEdited) name = if (it.isBlank()) "" else nameFromUrl(it.trim()) }, stringResource(R.string.settings_conn_address_label),
                    placeholder = stringResource(R.string.settings_conn_address_placeholder), enabled = !writes.busy,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                ReiTextField(name, { name = it; nameEdited = true }, stringResource(R.string.settings_triggers_name_label), enabled = !writes.busy)
                SecretField(token, { token = it }, stringResource(R.string.settings_conn_token_optional), supportingText = stringResource(R.string.settings_conn_token_optional_hint), enabled = !writes.busy)
                if (token.isNotBlank()) {
                    ReiTextField(tokenHeader, { tokenHeader = it.take(128) }, stringResource(R.string.settings_conn_token_header), placeholder = stringResource(R.string.settings_conn_token_header_placeholder), supportingText = stringResource(R.string.settings_conn_token_header_hint), enabled = !writes.busy)
                }
                FormButton(stringResource(R.string.settings_conn_add_btn), enabled = !writes.busy && url.isNotBlank(), onClick = {
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
fun ConnectorDetail(api: ReiApi, id: String, canRemove: Boolean, onBack: () -> Unit) {
    val writes = rememberWrites()
    val loaded = rememberResource("connectors.detail", id) {
        connectorList(api.request("GET", listOf("api", "connectors"))).firstOrNull { it.id == id }
    }
    var connector by remember(loaded.value) { mutableStateOf(loaded.value) }
    var tools by remember { mutableStateOf<List<ConnectorTool>?>(null) }
    var toolsError by remember { mutableStateOf<UiText?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var name by remember(connector?.name) { mutableStateOf(connector?.name.orEmpty()) }
    var token by remember { mutableStateOf("") }
    var tokenHeader by remember(connector?.tokenHeader) { mutableStateOf(connector?.tokenHeader.orEmpty()) }
    var confirmRemove by remember { mutableStateOf(false) }
    var confirmYolo by remember { mutableStateOf(false) }
    var notice by remember { mutableStateOf<UiText?>(null) }
    val current = connector

    suspend fun loadTools(refresh: Boolean) {
        refreshing = refresh
        try {
            val body = api.request("GET", listOf("api", "connectors", id, "tools"), query = if (refresh) mapOf("refresh" to "1") else emptyMap())
            tools = toolList(body)
            toolsError = null
        } catch (failure: ReiApiException) {
            tools = null
            toolsError = if (failure.code == "needs_auth") UiText.Resource(R.string.settings_conn_needs_auth_tools) else settingsError(failure)
        } finally {
            refreshing = false
        }
    }
    LaunchedEffect(current?.id, current?.status) {
        if (current?.status == "connected") loadTools(false)
        else toolsError = if (current?.status == "needs_auth") UiText.Resource(R.string.settings_conn_needs_auth_tools) else null
    }

    fun patch(body: JsonObject, then: () -> Unit = {}) = writes.run(then) {
        connector = api.request("PATCH", listOf("api", "connectors", id), body).obj("connector").connector()
    }

    SubScreen(current?.name ?: stringResource(R.string.settings_conn_single), onBack, busy = writes.busy || loaded.loading || refreshing, error = writes.error ?: loaded.error, onRetry = loaded::reload) {
        notice?.asString()?.let { StatusBanner(it) }
        if (current == null) {
            if (!loaded.loading && loaded.error == null) EmptyState(ReiIcons.Branch, stringResource(R.string.settings_conn_missing))
        } else {
            SettingsGroup(title = stringResource(R.string.chat_inspect_status)) {
                SettingsRow(
                    if (current.auth == "token" && current.status == "needs_auth") stringResource(R.string.settings_conn_token_rejected) else statusText(current).asString(),
                    summary = listOfNotNull(
                        addressHost(current.url),
                        current.pluginName?.let {
                            stringResource(if (current.pluginEnabled) R.string.settings_conn_part_of_plugin else R.string.settings_conn_part_of_plugin_disabled, it)
                        } ?: stringResource(R.string.settings_conn_standalone),
                    ).joinToString("\n"),
                )
            }
            FormGroup(title = stringResource(R.string.settings_triggers_name_label)) {
                ReiTextField(name, { name = it.take(80) }, stringResource(R.string.settings_conn_name_label), enabled = !writes.busy)
                FormButton(stringResource(R.string.settings_conn_save_name), primary = false, enabled = !writes.busy && name.isNotBlank() && name.trim() != current.name, onClick = {
                    patch(buildJsonObject { put("name", name.trim()) })
                })
            }
            if (current.status == "needs_auth" && current.auth != "token") {
                ConnectorSignIn(api, id, busy = writes.busy) { signedIn ->
                    connector = signedIn
                    notice = UiText.Resource(R.string.settings_conn_signed_in_notice, signedIn.name)
                    loaded.reload()
                }
            }
            if (current.auth == "token") {
                FormGroup(title = stringResource(R.string.settings_conn_token_auth_group), note = current.error.takeIf { current.status == "needs_auth" }) {
                    SecretField(token, { token = it }, stringResource(R.string.settings_conn_token_label), placeholder = stringResource(R.string.settings_conn_token_placeholder), enabled = !writes.busy)
                    ReiTextField(tokenHeader, { tokenHeader = it.take(128) }, stringResource(R.string.settings_conn_token_header), placeholder = stringResource(R.string.settings_conn_token_header_placeholder), supportingText = stringResource(R.string.settings_conn_token_header_hint), enabled = !writes.busy)
                    val body = authenticationBody(current, token, tokenHeader)
                    FormButton(stringResource(R.string.settings_conn_save_auth), enabled = !writes.busy && body != null, onClick = {
                        if (body != null) {
                            patch(body) { token = ""; tools = null }
                        }
                    })
                }
            }
            SettingsGroup(title = stringResource(R.string.settings_page_permissions)) {
                ChoiceRow(
                    stringResource(R.string.settings_conn_profile_label), current.mcpProfile ?: "always_ask", McpProfiles, icon = ReiIcons.Shield,
                    summary = stringResource(R.string.settings_conn_profile_hint),
                    enabled = !writes.busy && current.canSetProfile(), dividerBelow = true,
                    onSelect = { choice ->
                        if (choice == "yolo") confirmYolo = true
                        else writes.run { connector = api.request("PUT", listOf("api", "connectors", id, "profile"), profileBody(choice, current, false)).obj("connector").connector() }
                    },
                )
                SettingsSwitchRow(
                    stringResource(R.string.settings_conn_holds_private), current.holdsPrivate, { on -> patch(buildJsonObject { put("holdsPrivate", on) }) },
                    summary = stringResource(R.string.settings_conn_holds_private_hint), enabled = !writes.busy,
                )
            }
            SettingsGroup(title = stringResource(R.string.settings_conn_tools_group)) {
                SettingsRow(stringResource(R.string.settings_conn_tools_disclaimer))
                toolsError?.let { SettingsRow(it.asString(), destructive = true) }
                val list = tools
                if (list != null && list.isEmpty()) SettingsRow(stringResource(R.string.settings_conn_tools_empty))
                list?.forEachIndexed { index, tool ->
                    ChoiceRow(
                        tool.name, tool.current.wire,
                        ToolClass.entries.map {
                            val label = stringResource(it.labelRes)
                            Choice(it.wire, if (it == tool.defaultClass) stringResource(R.string.settings_conn_tool_default_suffix, label) else label)
                        },
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
                        SettingsRow(stringResource(R.string.settings_conn_reset_tool, tool.name, stringResource(tool.defaultClass.labelRes)), dividerBelow = index < list.lastIndex, onClick = {
                            writes.run { api.request("PUT", listOf("api", "connectors", id, "tools", tool.name), toolClassBody(tool, null)); tools = tools?.map { if (it.name == tool.name) it.withOverride(null) else it } }
                        })
                    }
                }
            }
            FormGroup {
                FormButton(stringResource(R.string.settings_conn_refresh_tools), primary = false, enabled = !writes.busy && !refreshing && current.status == "connected", onClick = {
                    writes.run { loadTools(true) }
                })
                if (canRemove) FormButton(stringResource(R.string.settings_conn_remove_btn), primary = false, enabled = !writes.busy, onClick = { confirmRemove = true })
            }
        }
    }
    if (confirmRemove && current != null) {
        ConfirmDialog(
            title = stringResource(R.string.settings_conn_remove_title),
            text = stringResource(R.string.settings_conn_remove_body, current.name),
            confirmLabel = stringResource(R.string.settings_passkeys_remove), destructive = true,
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
            title = stringResource(R.string.settings_conn_yolo_title),
            text = stringResource(R.string.settings_conn_yolo_body),
            confirmLabel = stringResource(R.string.settings_conn_yolo_confirm), destructive = true,
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
    var problem by remember { mutableStateOf<UiText?>(null) }
    val working = busy || writes.busy
    fun start(body: JsonObject) {
        problem = null
        writes.run {
            try {
                val url = api.request("POST", listOf("api", "connectors", connectorId, "oauth", "start"), body).let { it["authorizationUrl"]?.let { value -> value.jsonPrimitive.content } }.orEmpty()
                needsClient = false
                started = true
                if (!openInBrowser(context, url)) problem = UiText.Resource(R.string.settings_providers_oauth_no_browser)
            } catch (failure: ReiApiException) {
                if (failure.code == "client_id_required") needsClient = true else throw failure
            }
        }
    }
    FormGroup(title = stringResource(R.string.settings_conn_signin_group), note = problem?.asString()) {
        if (needsClient) {
            Text(stringResource(R.string.settings_conn_client_id_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            ReiTextField(clientId, { clientId = it }, stringResource(R.string.settings_conn_client_id), enabled = !working)
            SecretField(clientSecret, { clientSecret = it }, stringResource(R.string.settings_conn_client_secret), enabled = !working)
            FormButton(stringResource(R.string.settings_conn_continue_signin), enabled = !working && clientId.isNotBlank(), onClick = { start(clientIdBody(clientId, clientSecret)); clientSecret = "" })
        } else {
            FormButton(stringResource(if (started) R.string.settings_conn_open_signin_again else R.string.settings_conn_signin_action), primary = !started, enabled = !working, onClick = { start(clientIdBody("", "")) })
            if (started) {
                Text(
                    stringResource(R.string.settings_conn_signin_paste_hint),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                ReiTextField(pasted, { pasted = it }, stringResource(R.string.settings_conn_after_signin_label), placeholder = stringResource(R.string.settings_conn_after_signin_placeholder), enabled = !working)
                FormButton(stringResource(R.string.settings_providers_oauth_finish), enabled = !working && pasted.isNotBlank(), onClick = {
                    when (val result = signInReturn(pasted)) {
                        is SignInReturn.Code -> {
                            problem = null
                            writes.run({ pasted = "" }) {
                                onSignedIn(api.request("POST", listOf("api", "connectors", "oauth", "finish"), finishBody(result)).obj("connector").connector())
                            }
                        }
                        is SignInReturn.Failed -> problem = UiText.Resource(R.string.settings_conn_signin_failed, result.reason)
                        SignInReturn.None -> problem = UiText.Resource(R.string.settings_conn_signin_no_code)
                    }
                })
            }
        }
    }
}
