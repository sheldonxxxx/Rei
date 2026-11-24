package dev.rei.android.feature.settings

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import dev.rei.android.data.ChatProfile
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.objects
import dev.rei.android.data.obj
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
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
internal fun describeGrant(grant: GrantItem, sessionTitle: String?, agentName: String?): String = when (grant.length) {
    "always" -> "Always"
    "web_session" -> if (sessionTitle != null) "All web in “$sessionTitle”" else "All web in one chat"
    "session" -> if (sessionTitle != null) "For the chat “$sessionTitle”" else "For one chat"
    "agent" -> if (agentName != null) "For the agent $agentName" else "For one agent"
    "hours" -> dateTime(grant.expiresAt)?.let { "Until $it" } ?: "For a set time"
    else -> "For a set time"
}

/** A connector tool's grant destination is `<connectorId>.<tool>`: the app's name (when known) and the tool, or null. */
internal fun mcpTarget(destination: String?, names: Map<String, String>): Pair<String, String>? {
    if (destination == null) return null
    val dot = destination.indexOf('.')
    if (dot <= 0) return null
    return (names[destination.substring(0, dot)] ?: "A connected app") to destination.substring(dot + 1)
}

/** The grant's name: the app and tool for a connector tool, else `connector · operation`. */
internal fun grantName(grant: GrantItem, names: Map<String, String>): String {
    val target = if (grant.connector == "mcp") mcpTarget(grant.destination, names) else null
    return if (target != null) "${target.first} · ${target.second}" else "${grant.connector} · ${grant.operation}"
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

private suspend fun loadPermissions(api: ReiApi): PermissionsData {
    val agentRows = api.request("GET", listOf("api", "agents")).objects("agents")
    val grants = api.request("GET", listOf("api", "grants")).objects("grants").map { it.grant() }
    val connectors = runCatching {
        api.request("GET", listOf("api", "connectors")).objects("connectors").associate { it.string("id") to it.string("name") }
    }.getOrDefault(emptyMap())
    val titles = grants.mapNotNull { it.sessionId }.distinct().mapNotNull { id ->
        runCatching { id to api.request("GET", listOf("api", "sessions", id, "summary")).obj("session").string("title") }.getOrNull()
    }.toMap()
    return PermissionsData(
        agents = agentRows.map { AgentLevel(it.string("id"), it.string("name"), ChatProfile.fromWire(it.optionalString("defaultProfile"))) },
        grants = grants,
        connectorNames = connectors,
        agentNames = agentRows.associate { it.string("id") to it.string("name") },
        sessionTitles = titles,
    )
}

/**
 * Permissions: the level new chats start at for each agent, the sandbox network whitelist, and what you allowed in
 * advance, each revocable. The chat's permission sheet opens this screen.
 */
@Composable
fun PermissionsScreen(api: ReiApi, onBack: () -> Unit) {
    var sandbox by rememberSaveable { mutableStateOf(false) }
    BackHandler(sandbox) { sandbox = false }
    if (sandbox) SandboxNetworkScreen(api) { sandbox = false } else PermissionsMain(api, onBack) { sandbox = true }
}

@Composable
private fun PermissionsMain(api: ReiApi, onBack: () -> Unit, onSandbox: () -> Unit) {
    val writes = rememberWrites()
    val data = rememberResource(api) { loadPermissions(api) }
    var revoking by remember { mutableStateOf<GrantItem?>(null) }
    SubScreen("Permissions", onBack, busy = writes.busy || data.loading, error = writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            val named = loaded.agents.size > 1
            SettingsGroup(title = "New chats") {
                loaded.agents.forEachIndexed { index, agent ->
                    ChoiceRow(
                        title = if (named) "${agent.name}: start new chats at" else "Start new chats at",
                        selected = agent.profile.wire,
                        choices = ChatProfile.entries.map { Choice(it.wire, it.label, it.description) },
                        summary = "Chats already open keep their own level.",
                        enabled = !writes.busy,
                        dividerBelow = index < loaded.agents.lastIndex,
                        onSelect = { wire ->
                            writes.run(data::reload) { api.request("PATCH", listOf("api", "agents", agent.id), buildJsonObject { put("defaultProfile", wire) }) }
                        },
                    )
                }
            }
            if (loaded.agents.any { it.profile == ChatProfile.Yolo }) {
                StatusBanner("YOLO skips most approvals. Content the agent reads on the web could talk it into things you wouldn’t choose.", kind = StatusKind.Attention)
            }
            SettingsGroup(title = "Sandbox network") {
                SettingsRow(
                    "Allowed sites", icon = ReiIcons.Globe, summary = "Sites agents reach without asking.",
                    onClick = onSandbox, trailing = { SettingsChevron() },
                )
            }
            SettingsGroup(title = "Allowed in advance") {
                if (loaded.grants.isEmpty()) SettingsRow("Nothing allowed in advance.")
                loaded.grants.forEachIndexed { index, grant ->
                    val meta = listOfNotNull(
                        if (mcpTarget(grant.destination, loaded.connectorNames) == null || grant.connector != "mcp") grant.destination ?: "Any destination" else null,
                        describeGrant(grant, grant.sessionId?.let(loaded.sessionTitles::get), grant.agentId?.let(loaded.agentNames::get)),
                        dateTime(grant.createdAt)?.let { "Allowed $it" },
                    ).joinToString("\n")
                    SettingsRow(
                        grantName(grant, loaded.connectorNames), summary = meta, tabularSummary = true,
                        onClick = { revoking = grant }, dividerBelow = index < loaded.grants.lastIndex,
                        trailing = { SettingsChevron() },
                    )
                }
            }
        }
    }
    revoking?.let { grant ->
        ConfirmDialog(
            title = "Revoke ${grantName(grant, data.value?.connectorNames.orEmpty())}?",
            text = "Agents will ask again the next time they need it.",
            confirmLabel = "Revoke",
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
private fun SandboxNetworkScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val settings = rememberResource(api) {
        val body = api.request("GET", listOf("api", "settings", "sandbox-network"))
        body.stringList("whitelist") to body.stringList("defaults")
    }
    var entries by remember(settings.value) { mutableStateOf(settings.value?.first) }
    var draft by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val current = entries
    val dirty = current != null && current != settings.value?.first
    SubScreen("Sandbox network", onBack, busy = writes.busy || settings.loading, error = writes.error ?: settings.error, onRetry = settings::reload) {
        if (current != null) {
            SettingsGroup {
                SettingsRow(
                    "Whitelist agents reach these sites on ports 80 and 443 without asking. Use a host name (pypi.org), a wildcard for subdomains (*.github.com), an IP address, or a network (10.0.0.0/8).",
                )
            }
            SettingsGroup {
                SettingsRow(
                    "Local network: an address on your local network is reachable only when both its host name and the address are on this list. For example, add wiki.lan and 10.0.0.0/8 together. An agent set to Any reaches your local network without this list.",
                )
            }
            FormGroup {
                ReiTextField(draft, { draft = it; problem = null }, "Add a site or network", placeholder = "example.com", error = problem, enabled = !writes.busy)
                FormButton("Add", enabled = draft.isNotBlank() && !writes.busy, primary = false, onClick = {
                    when (val result = addWhitelistEntry(current, draft)) {
                        is AddEntry.Added -> { entries = result.entries; draft = ""; problem = null; saved = false }
                        is AddEntry.Refused -> problem = result.reason
                        AddEntry.Nothing -> Unit
                    }
                })
            }
            SettingsGroup(title = "${current.size} of $MaxWhitelistEntries entries") {
                if (current.isEmpty()) SettingsRow("The list is empty. Whitelist agents ask before reaching any site.")
                current.forEachIndexed { index, entry ->
                    SettingsRow(
                        entry, icon = ReiIcons.Globe, dividerBelow = index < current.lastIndex,
                        trailing = {
                            dev.rei.android.ui.components.ReiIconButton(ReiIcons.Close, "Remove $entry", { entries = current - entry; saved = false })
                        },
                    )
                }
            }
            FormGroup(note = if (saved) "Saved. Applies to the next request." else "Changes apply to the next request each agent makes.") {
                FormButton("Save whitelist", enabled = dirty && !writes.busy, onClick = {
                    writes.run({ saved = true; settings.reload() }) {
                        api.request("PUT", listOf("api", "settings", "sandbox-network"), buildJsonObject { put("whitelist", buildJsonArray { current.forEach { add(it) } }) })
                    }
                })
                FormButton("Restore defaults", primary = false, enabled = !writes.busy && current != settings.value?.second, onClick = {
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
