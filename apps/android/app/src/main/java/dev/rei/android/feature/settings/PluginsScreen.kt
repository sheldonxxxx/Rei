package dev.rei.android.feature.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.readUpTo
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonObject

private const val MaxImportBytes = 8 * 1024 * 1024
private const val NewPlugin = "new"

/**
 * Plugins: bundles of skills and MCP connections. List, import, create, edit, switch on and off, choose which agents get them,
 * retry connection setup, step back to an earlier revision, remove. A plugin's connection opens the native connector page.
 * [openId] opens one plugin straight away (a skill's "Part of the plugin"). Export stays on the web: it is a binary download.
 */
@Composable
fun PluginsScreen(api: ReiApi, onOpenPlugin: (String) -> Unit, onBack: () -> Unit) {
    PluginList(api, onBack, onOpenPlugin)
}

@Composable
private fun PluginList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val context = LocalContext.current
    val writes = rememberWrites()
    val list = rememberResource("plugins.list", api) { api.request("GET", listOf("api", "plugins")).objects("plugins").map { it.pluginRow() } }
    var problem by remember { mutableStateOf<UiText?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        problem = null
        writes.run {
            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readUpTo(MaxImportBytes + 1) }
            when {
                bytes == null -> problem = UiText.Resource(R.string.settings_skills_read_err)
                bytes.size > MaxImportBytes -> problem = UiText.Resource(R.string.settings_skills_too_large)
                else -> {
                    val id = api.request("POST", listOf("api", "plugins", "import"), pluginZipBody(bytes)).obj("plugin").pluginRow().id
                    list.reload()
                    onOpen(id)
                }
            }
        }
    }
    SubScreen(stringResource(R.string.settings_page_plugins), onBack, busy = writes.busy || list.loading, error = problem ?: writes.error ?: list.error, onRetry = list::reload) {
        val items = list.value
        if (items != null) {
            FormGroup(note = stringResource(R.string.settings_plugins_intro)) {
                FormButton(stringResource(R.string.settings_plugins_new_btn), enabled = !writes.busy, onClick = { onOpen(NewPlugin) })
                FormButton(stringResource(R.string.settings_plugins_import_btn), primary = false, enabled = !writes.busy, onClick = { picker.launch("*/*") })
            }
            SettingsGroup(title = stringResource(R.string.settings_plugins_your_group)) {
                if (items.isEmpty()) SettingsRow(stringResource(R.string.settings_plugins_empty))
                items.forEachIndexed { index, plugin ->
                    SettingsRow(
                        plugin.name, icon = ReiIcons.Puzzle,
                        summary = listOfNotNull(
                            plugin.description.takeIf { it.isNotBlank() }?.take(160),
                            listOfNotNull(
                                plugin.kind.asString(),
                                when {
                                    plugin.builtIn -> stringResource(R.string.settings_skills_builtin)
                                    !plugin.enabled -> stringResource(R.string.settings_plugins_disabled)
                                    else -> null
                                },
                            ).joinToString(" · "),
                        ).joinToString("\n"),
                        onClick = { onOpen(plugin.id) }, dividerBelow = index < items.lastIndex, trailing = { SettingsChevron() },
                    )
                }
            }
        }
    }
}

@Composable
fun PluginEditScreen(api: ReiApi, id: String, onBack: () -> Unit, onSaved: (String) -> Unit) {
    val writes = rememberWrites()
    val creating = id == NewPlugin
    val loaded = rememberResource("plugins.edit", id) { if (creating) null else pluginDetail(api.request("GET", listOf("api", "plugins", id))) }
    val data = loaded.value
    if (!creating && data == null) {
        SubScreen(stringResource(R.string.settings_plugins_edit_title), onBack, busy = loaded.loading, error = loaded.error, onRetry = loaded::reload) {}
        return
    }
    PluginEditor(
        initial = data?.pkg ?: emptyPackage(),
        existing = data != null,
        busy = writes.busy,
        error = writes.error,
        onCancel = onBack,
        onSave = { pkg ->
            writes.run {
                val saved = if (data != null) api.request("PATCH", listOf("api", "plugins", id), savePluginBody(pkg, data.row.revision))
                else api.request("POST", listOf("api", "plugins"), savePluginBody(pkg, null))
                onSaved(saved.obj("plugin").pluginRow().id)
            }
        },
    )
}

@Composable
fun PluginDetailScreen(api: ReiApi, id: String, onBack: () -> Unit, onEdit: (String) -> Unit, onOpenConnector: (String) -> Unit) {
    if (id == NewPlugin) {
        PluginEditScreen(api, id, onBack = onBack, onSaved = onEdit)
        return
    }
    val writes = rememberWrites()
    val loaded = rememberResource("plugins.detail", id) { pluginDetail(api.request("GET", listOf("api", "plugins", id))) }
    val agents = rememberResource("plugins.agents", api) { suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").map { it.agentOption() } }.getOrDefault(emptyList()) }
    var history by remember { mutableStateOf<PluginDetailData?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    val data = loaded.value

    fun act(block: suspend () -> Unit) = writes.run(loaded::reload, block)
    SubScreen(data?.row?.name ?: stringResource(R.string.settings_plugins_single), onBack, busy = writes.busy || loaded.loading, error = writes.error ?: loaded.error, onRetry = loaded::reload) {
        if (data != null) {
            val row = data.row
            SettingsGroup {
                SettingsRow(
                    row.description.ifBlank { row.name },
                    summary = listOfNotNull(
                        row.kind.asString(),
                        stringResource(R.string.settings_plugins_revision_short, row.revision),
                        if (row.builtIn) stringResource(R.string.settings_skills_builtin) else null,
                    ).joinToString(" · "),
                )
            }
            if (!row.builtIn) {
                FormGroup { FormButton(stringResource(R.string.settings_plugins_edit_btn), primary = false, enabled = !writes.busy, onClick = { onEdit(id) }) }
                SettingsGroup {
                    SettingsSwitchRow(stringResource(R.string.settings_tfa_enabled), row.enabled, { on -> act { api.request("PATCH", listOf("api", "plugins", id, "installation"), enabledBody(on)) } }, enabled = !writes.busy)
                }
                val options = agents.value.orEmpty()
                SettingsGroup(title = stringResource(R.string.settings_plugins_available_agents)) {
                    SettingsSwitchRow(stringResource(R.string.settings_skills_all_agents), row.agents == null, { all -> act { api.request("PATCH", listOf("api", "plugins", id, "installation"), allAgentsBody(all)) } }, enabled = !writes.busy, dividerBelow = row.agents != null)
                    val chosen = row.agents
                    if (chosen != null) options.forEachIndexed { index, agent ->
                        SettingsSwitchRow(agent.name, agent.id in chosen, { on -> act { api.request("PATCH", listOf("api", "plugins", id, "installation"), agentToggleBody(chosen, agent.id, on)) } }, enabled = !writes.busy, dividerBelow = index < options.lastIndex)
                    }
                }
            }
            if (data.pkg.skills.isNotEmpty()) {
                SettingsGroup(title = stringResource(R.string.settings_page_skills)) {
                    data.pkg.skills.forEachIndexed { index, skill -> PluginSkillRow(api, skill, dividerBelow = index < data.pkg.skills.lastIndex) }
                }
            }
            if (data.pkg.mcp.isNotEmpty()) {
                SettingsGroup(title = stringResource(R.string.settings_providers_connections)) {
                    data.pkg.mcp.forEachIndexed { _, connection ->
                        val installed = data.connections.firstOrNull { it.name == connection.name }
                        SettingsRow(
                            connection.name,
                            summary = listOfNotNull(connectionStatusWord(installed?.status).asString(), addressHost(connection.url), installed?.error.takeIf { installed?.status == "error" }).joinToString("\n"),
                            onClick = installed?.connectorId?.let { connectorId -> { onOpenConnector(connectorId) } },
                            dividerBelow = true,
                            trailing = if (installed?.connectorId != null) ({ SettingsChevron() }) else null,
                        )
                    }
                    SettingsRow(stringResource(R.string.settings_plugins_retry_setup), onClick = if (writes.busy) null else ({ act { api.request("POST", listOf("api", "plugins", id, "retry")) } }))
                }
            }
            if (data.revisions.isNotEmpty()) {
                SettingsGroup(title = stringResource(R.string.settings_plugins_revision_history)) {
                    ChoiceRow(
                        stringResource(R.string.settings_plugins_look_revision), history?.selectedRevision?.toString(),
                        data.revisions.map {
                            val who = stringResource(if (it.author == "agent") R.string.settings_plugins_author_agent else R.string.settings_plugins_author_you)
                            val base = stringResource(R.string.settings_plugins_revision_item, it.revision, who)
                            val label = dateTime(it.createdAt)?.let { d -> "$base · $d" } ?: base
                            Choice(it.revision.toString(), label)
                        },
                        placeholder = stringResource(R.string.settings_plugins_choose_revision), enabled = !writes.busy,
                        onSelect = { value -> writes.run { history = pluginDetail(api.request("GET", listOf("api", "plugins", id), query = mapOf("revision" to value))) } },
                    )
                    history?.let { revision -> SettingsRow(stringResource(R.string.settings_plugins_revision_short, revision.selectedRevision), summary = prettyPackage(revision.pkg), tabularSummary = true) }
                }
                history?.let { revision ->
                    if (!row.builtIn) FormGroup {
                        FormButton(stringResource(R.string.settings_plugins_restore_revision), primary = false, enabled = !writes.busy, onClick = {
                            writes.run({ history = null; loaded.reload() }) { api.request("PATCH", listOf("api", "plugins", id), savePluginBody(revision.pkg, row.revision)) }
                        })
                        FormButton(stringResource(R.string.settings_plugins_close_revision), primary = false, enabled = !writes.busy, onClick = { history = null })
                    }
                }
            }
            if (!row.builtIn) FormGroup { FormButton(stringResource(R.string.settings_plugins_remove_btn), primary = false, enabled = !writes.busy, onClick = { confirmRemove = true }) }
        } else if (!loaded.loading && loaded.error == null) EmptyState(ReiIcons.Puzzle, stringResource(R.string.settings_plugins_missing))
    }
    if (confirmRemove && data != null) {
        ConfirmDialog(
            title = stringResource(R.string.settings_providers_remove_title, data.row.name),
            text = stringResource(R.string.settings_plugins_remove_body),
            confirmLabel = stringResource(R.string.settings_plugins_remove_btn), destructive = true,
            onConfirm = {
                confirmRemove = false
                writes.run(onBack) {
                    try { api.request("DELETE", listOf("api", "plugins", id)) } catch (failure: ReiApiException) { if (failure.code != "not_found") throw failure }
                }
            },
            onDismiss = { confirmRemove = false },
        )
    }
}

/** One of a plugin's skills: its name, with the instructions shown when opened. */
@Composable
private fun PluginSkillRow(api: ReiApi, skill: PackageSkill, dividerBelow: Boolean) {
    var open by rememberSaveable(skill.name) { mutableStateOf(false) }
    SettingsRow(skill.name, onClick = { open = !open }, dividerBelow = dividerBelow && !open, trailing = { Text(stringResource(if (open) R.string.settings_skills_hide else R.string.settings_skills_view), color = MaterialTheme.colorScheme.primary) })
    if (open) Box(Modifier.padding(16.dp)) { ReiMarkdown(splitSkillMd(skill.skillMd).body, api) }
}

@Composable
private fun PluginEditor(initial: PluginPackage, existing: Boolean, busy: Boolean, error: UiText?, onSave: (PluginPackage) -> Unit, onCancel: () -> Unit) {
    // The draft lives in remember (not saved state): it can hold connection addresses and is rebuilt from the plugin on return.
    var pkg by remember(initial) { mutableStateOf(initial) }
    var problem by remember { mutableStateOf<UiText?>(null) }
    SubScreen(stringResource(if (existing) R.string.settings_plugins_edit_title else R.string.settings_plugins_new_btn), onCancel, busy = busy, error = problem ?: error) {
        FormGroup {
            ReiTextField(pkg.name, { pkg = pkg.copy(name = it) }, stringResource(R.string.settings_triggers_name_label), placeholder = stringResource(R.string.settings_plugins_name_placeholder), enabled = !existing && !busy)
            ReiTextField(pkg.description, { pkg = pkg.copy(description = it) }, stringResource(R.string.knowledge_page_field_description), singleLine = false, minLines = 2, enabled = !busy)
        }
        pkg.skills.forEachIndexed { index, skill ->
            FormGroup(title = stringResource(R.string.settings_plugins_skill_header, index + 1)) {
                ReiTextField(skill.name, { pkg = pkg.renameSkill(index, it) }, stringResource(R.string.settings_plugins_skill_name), enabled = !busy)
                ReiTextField(skill.skillMd, { pkg = pkg.setSkillMd(index, it) }, stringResource(R.string.settings_skills_md_label), singleLine = false, minLines = 6, enabled = !busy)
                FormButton(stringResource(R.string.settings_plugins_remove_skill), primary = false, enabled = !busy, onClick = { pkg = pkg.removeSkill(index) })
            }
        }
        FormGroup { FormButton(stringResource(R.string.settings_plugins_add_skill), primary = false, enabled = !busy, onClick = { pkg = pkg.addSkill() }) }
        pkg.mcp.forEachIndexed { index, connection ->
            FormGroup(title = stringResource(R.string.settings_plugins_conn_header, index + 1)) {
                ReiTextField(connection.name, { v -> pkg = pkg.updateConnection(index) { it.copy(name = v) } }, stringResource(R.string.settings_plugins_conn_name), enabled = !busy)
                ReiTextField(connection.url, { v -> pkg = pkg.updateConnection(index) { it.copy(url = v) } }, stringResource(R.string.settings_plugins_server_url), placeholder = stringResource(R.string.settings_conn_address_placeholder), enabled = !busy)
                ChoiceRow(stringResource(R.string.settings_plugins_auth_label), connection.auth, ConnectionAuth, onSelect = { v -> pkg = pkg.updateConnection(index) { it.copy(auth = v) } }, enabled = !busy)
                if (pkg.skills.isNotEmpty()) {
                    Text(stringResource(R.string.settings_plugins_skills_first), style = MaterialTheme.typography.labelLarge)
                    pkg.skills.forEach { skill ->
                        val checked = skill.name in connection.skills
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .toggleable(value = checked, enabled = !busy, role = Role.Checkbox) { on ->
                                    pkg = pkg.updateConnection(index) { it.withSkill(skill.name, on) }
                                }
                                .padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked, onCheckedChange = null, enabled = !busy, modifier = Modifier.clearAndSetSemantics {})
                            Text(skill.name, Modifier.padding(start = 8.dp))
                        }
                    }
                }
                FormButton(stringResource(R.string.settings_plugins_remove_conn), primary = false, enabled = !busy, onClick = { pkg = pkg.removeConnection(index) })
            }
        }
        FormGroup { FormButton(stringResource(R.string.settings_plugins_add_conn), primary = false, enabled = !busy, onClick = { pkg = pkg.addConnection() }) }
        FormGroup {
            FormButton(stringResource(if (busy) R.string.knowledge_page_saving else R.string.settings_plugins_save_btn), enabled = !busy, onClick = {
                problem = packageProblem(pkg)
                if (problem == null) onSave(pkg)
            })
            FormButton(stringResource(R.string.common_cancel), primary = false, enabled = !busy, onClick = onCancel)
        }
    }
}
