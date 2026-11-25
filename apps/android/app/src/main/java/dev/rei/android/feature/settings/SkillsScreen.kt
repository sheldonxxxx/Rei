package dev.rei.android.feature.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
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
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.data.objects
import dev.rei.android.readUpTo
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonObject

private const val MaxImportBytes = 8 * 1024 * 1024

/**
 * Skills: instructions an assistant reads before a task, standalone or from a plugin. [onOpenPlugin] opens the plugin a skill
 * belongs to; [openId] opens one skill straight away (a plugin's skill list).
 */
@Composable
fun SkillsScreen(api: ReiApi, onOpenSkill: (String) -> Unit, onBack: () -> Unit) {
    SkillList(api, onBack, onOpenSkill)
}

@Composable
private fun SkillList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val context = LocalContext.current
    val writes = rememberWrites()
    val data = rememberResource("skills.list", api) {
        val skills = api.request("GET", listOf("api", "skills")).objects("skills").map { it.skillSummary() }
        val agents = suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").map { it.agentOption() } }.getOrDefault(emptyList())
        skills to agents
    }
    var creating by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var problem by remember { mutableStateOf<UiText?>(null) }
    fun created(response: JsonObject) {
        creating = false; name = ""; description = ""; body = ""
        data.reload()
        onOpen(response.skillSummaryOf().id)
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        problem = null
        writes.run {
            val resolver = context.contentResolver
            val bytes = resolver.openInputStream(uri)?.use { it.readUpTo(MaxImportBytes + 1) }
            when {
                bytes == null -> problem = UiText.Resource(R.string.settings_skills_read_err)
                bytes.size > MaxImportBytes -> problem = UiText.Resource(R.string.settings_skills_too_large)
                else -> {
                    val label = uri.lastPathSegment.orEmpty().substringAfterLast('/')
                    created(api.request("POST", listOf("api", "skills"), importBody(label, resolver.getType(uri), bytes)))
                }
            }
        }
    }
    SubScreen(stringResource(R.string.settings_page_skills), onBack, busy = writes.busy || data.loading, error = problem ?: writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            val (skills, agents) = loaded
            SettingsGroup {
                SettingsRow(stringResource(R.string.settings_skills_intro))
            }
            FormGroup {
                if (creating) {
                    ReiTextField(
                        name, { name = it.lowercase().take(64) }, stringResource(R.string.settings_triggers_name_label),
                        placeholder = stringResource(R.string.settings_skills_name_placeholder),
                        supportingText = stringResource(R.string.settings_skills_name_hint),
                        error = if (name.isNotEmpty() && !isSkillName(name)) stringResource(R.string.settings_skills_name_error) else null,
                        enabled = !writes.busy,
                    )
                    ReiTextField(description, { description = it }, stringResource(R.string.knowledge_page_field_description), placeholder = stringResource(R.string.settings_skills_desc_placeholder), enabled = !writes.busy)
                    ReiTextField(body, { body = it }, stringResource(R.string.settings_skills_instructions_label), singleLine = false, minLines = 6, enabled = !writes.busy)
                    FormButton(stringResource(R.string.settings_skills_create_btn), enabled = !writes.busy && newSkillReady(name, description, body), onClick = {
                        problem = null
                        writes.run { created(api.request("POST", listOf("api", "skills"), newSkillBody(name, description, body))) }
                    })
                    FormButton(stringResource(R.string.common_cancel), primary = false, enabled = !writes.busy, onClick = { creating = false })
                } else {
                    FormButton(stringResource(R.string.settings_skills_new_btn), enabled = !writes.busy, onClick = { creating = true })
                    FormButton(stringResource(R.string.settings_skills_import_btn), primary = false, enabled = !writes.busy, onClick = { picker.launch("*/*") })
                }
            }
            SettingsGroup(title = stringResource(R.string.settings_skills_your_group)) {
                if (skills.isEmpty()) SettingsRow(stringResource(R.string.settings_skills_empty))
                skills.forEachIndexed { index, skill ->
                    SettingsRow(
                        skill.name, icon = ReiIcons.Sparkle,
                        summary = listOfNotNull(
                            skill.description.takeIf { it.isNotBlank() }?.take(160),
                            listOfNotNull(
                                if (skill.builtIn) stringResource(R.string.settings_skills_builtin)
                                else skill.pluginName?.let {
                                    stringResource(if (skill.pluginEnabled) R.string.settings_conn_plugin_part else R.string.settings_conn_plugin_disabled, it)
                                } ?: stringResource(R.string.settings_skills_standalone),
                                stringResource(R.string.settings_skills_version_short, skill.version),
                            ).joinToString(" · "),
                            if (skill.builtIn) stringResource(R.string.settings_skills_builtin_readonly)
                            else listOfNotNull(
                                agentsLine(skill.agents, agents).asString(),
                                dateTime(skill.updatedAt)?.let { stringResource(R.string.settings_skills_updated, it) },
                                stringResource(if (skill.author == "agent") R.string.settings_skills_saved_by_agent else R.string.settings_skills_edited_by_you),
                            ).joinToString(" · "),
                        ).joinToString("\n"),
                        onClick = { onOpen(skill.id) }, dividerBelow = index < skills.lastIndex, trailing = { SettingsChevron() },
                    )
                }
            }
        }
    }
}

@Composable
fun SkillDetailScreen(api: ReiApi, id: String, onBack: () -> Unit, onOpenPlugin: ((String) -> Unit)?) {
    val writes = rememberWrites()
    var viewing by rememberSaveable { mutableStateOf<Long?>(null) }
    var missing by remember { mutableStateOf(false) }
    val loaded = rememberResource("skills.detail", id to viewing) {
        try {
            skillData(api.request("GET", listOf("api", "skills", id), query = viewing?.let { mapOf("version" to it.toString()) } ?: emptyMap()))
        } catch (failure: ReiApiException) {
            if (failure.code == "not_found") { missing = true; null } else throw failure
        }
    }
    val agents = rememberResource("skills.agents", api) { suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").map { it.agentOption() } }.getOrDefault(emptyList()) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val data = loaded.value
    SubScreen(data?.skill?.name ?: stringResource(R.string.settings_skills_single), onBack, busy = writes.busy || loaded.loading, error = writes.error ?: loaded.error, onRetry = loaded::reload) {
        if (missing) EmptyState(ReiIcons.Sparkle, stringResource(R.string.settings_skills_missing))
        if (data != null) {
            val skill = data.skill
            SettingsGroup {
                SettingsRow(
                    skill.description.ifBlank { skill.name },
                    summary = if (skill.builtIn) stringResource(R.string.settings_skills_builtin_readonly_short)
                    else skill.pluginName?.let {
                        stringResource(if (skill.pluginEnabled) R.string.settings_conn_part_of_plugin else R.string.settings_conn_part_of_plugin_disabled, it)
                    } ?: stringResource(R.string.settings_conn_standalone),
                    onClick = if (!skill.builtIn && skill.pluginId != null && onOpenPlugin != null) ({ onOpenPlugin(skill.pluginId) }) else null,
                    trailing = if (!skill.builtIn && skill.pluginId != null && onOpenPlugin != null) ({ SettingsChevron() }) else null,
                )
            }
            if (!data.current) {
                StatusBanner(stringResource(R.string.settings_skills_old_version, data.version, skill.version), kind = StatusKind.Attention, actionLabel = stringResource(R.string.settings_skills_back_to_current), onAction = { viewing = null })
            }
            if (data.current && !editing && !skill.builtIn) {
                FormGroup { FormButton(stringResource(R.string.settings_skills_edit_md), primary = false, enabled = !writes.busy && data.skillMd != null, onClick = { text = data.skillMd?.content.orEmpty(); editing = true }) }
            }
            val skillMd = data.skillMd
            if (editing && skillMd != null) {
                FormGroup(title = stringResource(R.string.settings_skills_md_label), note = stringResource(R.string.settings_skills_md_note)) {
                    ReiTextField(text, { text = it }, stringResource(R.string.settings_skills_md_label), singleLine = false, minLines = 12, enabled = !writes.busy)
                    FormButton(stringResource(R.string.common_save), enabled = !writes.busy && text != skillMd.content, onClick = {
                        writes.run({ editing = false; loaded.reload() }) { api.request("PATCH", listOf("api", "skills", id), editBody(data.files, text)) }
                    })
                    FormButton(stringResource(R.string.common_cancel), primary = false, enabled = !writes.busy, onClick = { editing = false })
                }
            } else {
                SettingsGroup(title = stringResource(R.string.settings_skills_md_header, data.version)) {
                    val md = skillMd
                    if (md == null) SettingsRow(stringResource(R.string.settings_skills_md_missing))
                    else {
                        val parts = splitSkillMd(md.content)
                        parts.fields.filter { it.first != "name" && it.first != "description" }.forEach { (key, value) -> SettingsRow(key, summary = value) }
                        Box(Modifier.padding(16.dp)) { ReiMarkdown(parts.body, api) }
                    }
                }
            }
            if (data.others.isNotEmpty()) {
                SettingsGroup(title = stringResource(R.string.settings_skills_other_files)) {
                    data.others.forEachIndexed { index, file -> SkillFileRow(file, dividerBelow = index < data.others.lastIndex) }
                }
            }
            val options = agents.value.orEmpty()
            if (options.size > 1 && data.current && !skill.builtIn) {
                AgentAllow(options, skill.agents, enabled = !writes.busy) { body -> writes.run(loaded::reload) { api.request("PATCH", listOf("api", "skills", id), body) } }
            }
            SettingsGroup(title = stringResource(R.string.settings_skills_versions_group)) {
                data.versions.forEachIndexed { index, version ->
                    val isCurrent = version.version == skill.version
                    SettingsRow(
                        stringResource(if (isCurrent) R.string.viewer_history_version_current else R.string.viewer_history_version, version.version),
                        summary = listOfNotNull(
                            listOfNotNull(
                                when {
                                    skill.builtIn -> stringResource(R.string.settings_skills_included_rei)
                                    version.author == "agent" -> stringResource(R.string.settings_skills_by_agent)
                                    else -> stringResource(R.string.settings_skills_by_you)
                                },
                                if (skill.builtIn) null else dateTime(version.createdAt),
                            ).joinToString(" · "),
                            version.note.takeIf { it.isNotBlank() },
                        ).joinToString("\n"),
                        dividerBelow = index < data.versions.lastIndex,
                        trailing = {
                            Row {
                                if (version.version != data.version) ReiIconButton(ReiIcons.Eye, stringResource(R.string.settings_skills_view_version, version.version), { viewing = if (isCurrent) null else version.version })
                                if (!isCurrent && !skill.builtIn) ReiIconButton(ReiIcons.Undo, stringResource(R.string.settings_skills_restore_version, version.version), { writes.run({ viewing = null; loaded.reload() }) { api.request("PATCH", listOf("api", "skills", id), restoreBody(version.version)) } }, enabled = !writes.busy)
                            }
                        },
                    )
                }
            }
            if (!skill.builtIn) FormGroup { FormButton(stringResource(R.string.settings_skills_delete_btn), primary = false, enabled = !writes.busy, onClick = { confirmDelete = true }) }
        }
    }
    if (confirmDelete && data != null) {
        ConfirmDialog(
            title = stringResource(R.string.settings_skills_delete_title, data.skill.name),
            text = stringResource(R.string.settings_skills_delete_body),
            confirmLabel = stringResource(R.string.common_delete), destructive = true,
            onConfirm = {
                confirmDelete = false
                writes.run(onBack) {
                    try { api.request("DELETE", listOf("api", "skills", id)) } catch (failure: ReiApiException) { if (failure.code != "not_found") throw failure }
                }
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

/** One extra file of a skill: its path, with its text shown when opened. */
@Composable
private fun SkillFileRow(file: SkillFile, dividerBelow: Boolean) {
    var open by rememberSaveable(file.path) { mutableStateOf(false) }
    SettingsRow(
        file.path,
        summary = if (open) (if (file.isText) file.content else stringResource(R.string.settings_skills_binary_file)) else null,
        onClick = { open = !open },
        dividerBelow = dividerBelow,
        trailing = { Text(stringResource(if (open) R.string.settings_skills_hide else R.string.settings_skills_view), color = MaterialTheme.colorScheme.primary) },
    )
}

/** Which agents see the skill: all, or only the ones ticked. Shown only when there is more than one agent. */
@Composable
private fun AgentAllow(agents: List<AgentOption>, saved: List<String>?, enabled: Boolean, onSave: (JsonObject) -> Unit) {
    var only by remember(saved) { mutableStateOf(saved != null) }
    var picked by remember(saved) { mutableStateOf((saved ?: agents.map { it.id }).toSet()) }
    FormGroup(title = stringResource(R.string.settings_skills_who_group)) {
        ChoiceRowInline(only, enabled) { only = it }
        if (only) agents.forEach { agent ->
            val checked = agent.id in picked
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .toggleable(value = checked, enabled = enabled, role = Role.Checkbox) { on ->
                        picked = if (on) picked + agent.id else picked - agent.id
                    }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked, onCheckedChange = null, enabled = enabled, modifier = Modifier.clearAndSetSemantics {})
                Text(agent.name, Modifier.padding(start = 8.dp))
            }
        }
        FormButton(stringResource(R.string.common_save), primary = false, enabled = enabled && agentsChanged(saved, only, picked), onClick = { onSave(agentsBody(only, picked, agents)) })
    }
}

@Composable
private fun ChoiceRowInline(only: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    ChoiceRow(
        stringResource(R.string.settings_skills_available_to), if (only) "some" else "all",
        listOf(
            Choice("all", UiText.Resource(R.string.settings_skills_every_agent)),
            Choice("some", UiText.Resource(R.string.settings_skills_some_agents)),
        ),
        onSelect = { onChange(it == "some") }, enabled = enabled,
    )
}
