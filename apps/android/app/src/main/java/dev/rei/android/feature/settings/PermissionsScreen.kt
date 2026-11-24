package dev.rei.android.feature.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
import dev.rei.android.data.ChatProfile
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.objects
import dev.rei.android.data.obj
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put

/** One permission granted in advance (`GET /api/grants`). */
internal data class GrantItem(
    val id: String,
    val connector: String,
    val operation: String,
    val destination: String?,
    val length: String,
    val sessionId: String?,
    val agentId: String?,
    val expiresAt: Long?,
    val createdAt: Long?,
)

internal fun JsonObject.grant() = GrantItem(
    string("id"), string("connector"), string("operation"), optionalString("destination"), string("length"),
    optionalString("sessionId"), optionalString("agentId"), optionalString("expiresAt")?.toLongOrNull(), optionalString("createdAt")?.toLongOrNull(),
)

/** How long a grant lasts, in the web's words. [sessionTitle] and [agentName] are null when the chat or agent is not known. */
internal fun describeGrant(grant: GrantItem, sessionTitle: String?, agentName: String?): UiText = when (grant.length) {
    "always" -> UiText.Resource(R.string.settings_perm_always)
    "web_session" -> if (sessionTitle != null) UiText.Resource(R.string.settings_perm_web_session_named, sessionTitle) else UiText.Resource(R.string.settings_perm_web_session_anon)
    "session" -> if (sessionTitle != null) UiText.Resource(R.string.settings_perm_session_named, sessionTitle) else UiText.Resource(R.string.settings_perm_session_anon)
    "agent" -> if (agentName != null) UiText.Resource(R.string.settings_perm_agent_named, agentName) else UiText.Resource(R.string.settings_perm_agent_anon)
    "hours" -> dateTime(grant.expiresAt)?.let { UiText.Resource(R.string.settings_perm_hours_until, it) } ?: UiText.Resource(R.string.settings_perm_set_time)
    else -> UiText.Resource(R.string.settings_perm_set_time)
}

/** A connector tool's grant destination is `<connectorId>.<tool>`: the app's name (when known) and the tool, or null. */
internal fun mcpTarget(destination: String?, names: Map<String, String>): Pair<UiText, String>? {
    if (destination == null) return null
    val dot = destination.indexOf('.')
    if (dot <= 0) return null
    val appName = names[destination.substring(0, dot)]?.let(UiText::Literal) ?: UiText.Resource(R.string.settings_perm_connected_app)
    return appName to destination.substring(dot + 1)
}

/** The grant's name: the app and tool for a connector tool, else `connector · operation`. */
internal fun grantName(grant: GrantItem, names: Map<String, String>): UiText {
    val target = if (grant.connector == "mcp") mcpTarget(grant.destination, names) else null
    return if (target != null) UiText.Resource(R.string.settings_perm_pair, target.first, target.second)
    else UiText.Resource(R.string.settings_perm_pair, grant.connector, grant.operation)
}

/** Everything the Permissions screen reads: agents (default level), grants and the names that label a grant. */
private data class PermissionsData(
    val agents: List<AgentLevel>,
    val grants: List<GrantItem>,
    val connectorNames: Map<String, String>,
    val agentNames: Map<String, String>,
    val sessionTitles: Map<String, String>,
)

private data class AgentLevel(val id: String, val name: String, val profile: ChatProfile)

private suspend fun loadPermissions(api: ReiApi): PermissionsData = coroutineScope {
    val agentsJob = async { api.request("GET", listOf("api", "agents")).objects("agents") }
    val grantsJob = async { api.request("GET", listOf("api", "grants")).objects("grants").map { it.grant() } }
    val connectorsJob = async {
        suspendRunCatching {
            api.request("GET", listOf("api", "connectors")).objects("connectors").associate { it.string("id") to it.string("name") }
        }.getOrDefault(emptyMap())
    }
    val agentRows = agentsJob.await()
    val grants = grantsJob.await()
    val titles = grants.mapNotNull { it.sessionId }.distinct().map { id ->
        async {
            suspendRunCatching {
                id to api.request("GET", listOf("api", "sessions", id, "summary")).obj("session").string("title")
            }.getOrNull()
        }
    }.awaitAll().filterNotNull().toMap()
    PermissionsData(
        agents = agentRows.map { AgentLevel(it.string("id"), it.string("name"), ChatProfile.fromWire(it.optionalString("defaultProfile"))) },
        grants = grants,
        connectorNames = connectorsJob.await(),
        agentNames = agentRows.associate { it.string("id") to it.string("name") },
        sessionTitles = titles,
    )
}

/**
 * Permissions: the level new chats start at for each agent, the sandbox network whitelist, and what you allowed in
 * advance, each revocable. The chat's permission sheet opens this screen.
 */
@Composable
fun PermissionsScreen(api: ReiApi, onOpenSandbox: () -> Unit, onBack: () -> Unit) {
    PermissionsMain(api, onBack, onOpenSandbox)
}

@Composable
private fun PermissionsMain(api: ReiApi, onBack: () -> Unit, onSandbox: () -> Unit) {
    val writes = rememberWrites()
    val data = rememberResource(api) { loadPermissions(api) }
    var revoking by remember { mutableStateOf<GrantItem?>(null) }
    SubScreen(stringResource(R.string.settings_page_permissions), onBack, busy = writes.busy || data.loading, error = writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            val named = loaded.agents.size > 1
            SettingsGroup(title = stringResource(R.string.settings_perm_new_chats)) {
                loaded.agents.forEachIndexed { index, agent ->
                    ChoiceRow(
                        title = if (named) stringResource(R.string.settings_perm_start_named, agent.name) else stringResource(R.string.settings_perm_start_default),
                        selected = agent.profile.wire,
                        choices = ChatProfile.entries.map {
                            Choice(
                                it.wire,
                                UiText.Resource(it.labelRes),
                                UiText.Resource(it.descriptionRes),
                            )
                        },
                        summary = stringResource(R.string.settings_perm_existing_note),
                        enabled = !writes.busy,
                        dividerBelow = index < loaded.agents.lastIndex,
                        onSelect = { wire ->
                            writes.run(data::reload) { api.request("PATCH", listOf("api", "agents", agent.id), buildJsonObject { put("defaultProfile", wire) }) }
                        },
                    )
                }
            }
            if (loaded.agents.any { it.profile == ChatProfile.Yolo }) {
                StatusBanner(stringResource(R.string.settings_perm_yolo_banner), kind = StatusKind.Attention)
            }
            SettingsGroup(title = stringResource(R.string.settings_perm_sandbox_group)) {
                SettingsRow(
                    stringResource(R.string.settings_perm_allowed_sites), icon = ReiIcons.Globe, summary = stringResource(R.string.settings_perm_allowed_sites_summary),
                    onClick = onSandbox, trailing = { SettingsChevron() },
                )
            }
            SettingsGroup(title = stringResource(R.string.settings_perm_preapproved_group)) {
                if (loaded.grants.isEmpty()) SettingsRow(stringResource(R.string.settings_perm_preapproved_empty))
                loaded.grants.forEachIndexed { index, grant ->
                    val meta = listOfNotNull(
                        if (mcpTarget(grant.destination, loaded.connectorNames) == null || grant.connector != "mcp") grant.destination ?: stringResource(R.string.settings_perm_any_destination) else null,
                        describeGrant(grant, grant.sessionId?.let(loaded.sessionTitles::get), grant.agentId?.let(loaded.agentNames::get)).asString(),
                        dateTime(grant.createdAt)?.let { stringResource(R.string.settings_perm_allowed_at, it) },
                    ).joinToString("\n")
                    SettingsRow(
                        grantName(grant, loaded.connectorNames).asString(), summary = meta, tabularSummary = true,
                        onClick = { revoking = grant }, dividerBelow = index < loaded.grants.lastIndex,
                        trailing = { SettingsChevron() },
                    )
                }
            }
        }
    }
    revoking?.let { grant ->
        ConfirmDialog(
            title = stringResource(R.string.settings_perm_revoke_title, grantName(grant, data.value?.connectorNames.orEmpty()).asString()),
            text = stringResource(R.string.settings_perm_revoke_body),
            confirmLabel = stringResource(R.string.settings_devices_revoke),
            destructive = true,
            onConfirm = {
                revoking = null
                writes.run(data::reload) {
                    try {
                        api.request("DELETE", listOf("api", "grants", grant.id))
                    } catch (failure: ReiApiException) {
                        if (failure.code != "not_found") throw failure // already gone: same result
                    }
                }
            },
            onDismiss = { revoking = null },
        )
    }
}

/** The sandbox whitelist: add or remove entries, save, or restore the defaults. The server checks every entry on save. */
@Composable
fun SandboxNetworkScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val settings = rememberResource(api) {
        val body = api.request("GET", listOf("api", "settings", "sandbox-network"))
        body.stringList("whitelist") to body.stringList("defaults")
    }
    var entries by remember(settings.value) { mutableStateOf(settings.value?.first) }
    var draft by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<UiText?>(null) }
    var saved by remember { mutableStateOf(false) }
    val current = entries
    val dirty = current != null && current != settings.value?.first
    SubScreen(stringResource(R.string.settings_perm_sandbox_group), onBack, busy = writes.busy || settings.loading, error = writes.error ?: settings.error, onRetry = settings::reload) {
        if (current != null) {
            SettingsGroup {
                SettingsRow(stringResource(R.string.settings_perm_sandbox_whitelist_note))
            }
            SettingsGroup {
                SettingsRow(stringResource(R.string.settings_perm_sandbox_local_note))
            }
            FormGroup {
                ReiTextField(draft, { draft = it; problem = null }, stringResource(R.string.settings_perm_sandbox_add_label), placeholder = stringResource(R.string.settings_perm_sandbox_placeholder), error = problem?.asString(), enabled = !writes.busy)
                FormButton(stringResource(R.string.knowledge_page_add), enabled = draft.isNotBlank() && !writes.busy, primary = false, onClick = {
                    when (val result = addWhitelistEntry(current, draft)) {
                        is AddEntry.Added -> { entries = result.entries; draft = ""; problem = null; saved = false }
                        is AddEntry.Refused -> problem = result.reason
                        AddEntry.Nothing -> Unit
                    }
                })
            }
            SettingsGroup(title = stringResource(R.string.settings_perm_sandbox_count, current.size, MaxWhitelistEntries)) {
                if (current.isEmpty()) SettingsRow(stringResource(R.string.settings_perm_sandbox_empty))
                current.forEachIndexed { index, entry ->
                    SettingsRow(
                        entry, icon = ReiIcons.Globe, dividerBelow = index < current.lastIndex,
                        trailing = {
                            dev.rei.android.ui.components.ReiIconButton(ReiIcons.Close, stringResource(R.string.settings_providers_remove_cd, entry), { entries = current - entry; saved = false })
                        },
                    )
                }
            }
            FormGroup(note = stringResource(if (saved) R.string.settings_perm_sandbox_saved else R.string.settings_perm_sandbox_hint)) {
                FormButton(stringResource(R.string.settings_perm_sandbox_save), enabled = dirty && !writes.busy, onClick = {
                    writes.run({ saved = true; settings.reload() }) {
                        api.request("PUT", listOf("api", "settings", "sandbox-network"), buildJsonObject { put("whitelist", buildJsonArray { current.forEach { add(it) } }) })
                    }
                })
                FormButton(stringResource(R.string.settings_perm_sandbox_restore), primary = false, enabled = !writes.busy && current != settings.value?.second, onClick = {
                    writes.run({ saved = true; settings.reload() }) {
                        api.request("PUT", listOf("api", "settings", "sandbox-network"), buildJsonObject { put("reset", true) })
                    }
                })
            }
        }
    }
}

internal fun JsonObject.stringList(key: String): List<String> =
    (this[key] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }
