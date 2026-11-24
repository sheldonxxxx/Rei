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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.data.objects
import dev.rei.android.readUpTo
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
    val data = rememberResource(api) {
        val skills = api.request("GET", listOf("api", "skills")).objects("skills").map { it.skillSummary() }
        val agents = suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").map { it.agentOption() } }.getOrDefault(emptyList())
        skills to agents
    }
    var creating by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
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
                bytes == null -> problem = "That file could not be read."
                bytes.size > MaxImportBytes -> problem = "That file is too large to import here (8 MB at most)."
                else -> {
                    val label = uri.lastPathSegment.orEmpty().substringAfterLast('/')
                    created(api.request("POST", listOf("api", "skills"), importBody(label, resolver.getType(uri), bytes)))
                }
            }
        }
    }
    SubScreen("Skills", onBack, busy = writes.busy || data.loading, error = problem ?: writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            val (skills, agents) = loaded
            SettingsGroup {
                SettingsRow("Instructions an agent reads before a task. A skill you add here stands on its own; a plugin's skills are named plugin/skill.")
            }
            FormGroup {
                if (creating) {
                    ReiTextField(name, { name = it.lowercase().take(64) }, "Name", placeholder = "weekly-review", supportingText = "Lowercase letters, numbers and single hyphens.", error = if (name.isNotEmpty() && !isSkillName(name)) "Use lowercase letters, numbers and single hyphens." else null, enabled = !writes.busy)
                    ReiTextField(description, { description = it }, "Description", placeholder = "What it does and when to use it", enabled = !writes.busy)
                    ReiTextField(body, { body = it }, "Instructions", singleLine = false, minLines = 6, enabled = !writes.busy)
                    FormButton("Create skill", enabled = !writes.busy && newSkillReady(name, description, body), onClick = {
                        problem = null
                        writes.run { created(api.request("POST", listOf("api", "skills"), newSkillBody(name, description, body))) }
                    })
                    FormButton("Cancel", primary = false, enabled = !writes.busy, onClick = { creating = false })
                } else {
                    FormButton("New skill", enabled = !writes.busy, onClick = { creating = true })
                    FormButton("Import a skill (.zip or SKILL.md)", primary = false, enabled = !writes.busy, onClick = { picker.launch("*/*") })
                }
            }
            SettingsGroup(title = "Your skills") {
                if (skills.isEmpty()) SettingsRow("No skills yet.")
                skills.forEachIndexed { index, skill ->
                    SettingsRow(
                        skill.name, icon = ReiIcons.Sparkle,
                        summary = listOfNotNull(
                            skill.description.takeIf { it.isNotBlank() }?.take(160),
                            listOfNotNull(
                                if (skill.builtIn) "Built-in" else skill.pluginName?.let { "Plugin: $it" + if (skill.pluginEnabled) "" else " (disabled)" } ?: "Standalone",
                                "v${skill.version}",
                            ).joinToString(" · "),
                            if (skill.builtIn) "Included with Rei · Read-only" else listOfNotNull(agentsLine(skill.agents, agents), dateTime(skill.updatedAt)?.let { "Updated $it" }, if (skill.author == "agent") "Saved by an agent" else "Edited by you").joinToString(" · "),
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
    val loaded = rememberResource(id to viewing) {
        try {
            skillData(api.request("GET", listOf("api", "skills", id), query = viewing?.let { mapOf("version" to it.toString()) } ?: emptyMap()))
        } catch (failure: ReiApiException) {
            if (failure.code == "not_found") { missing = true; null } else throw failure
        }
    }
    val agents = rememberResource(api) { suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").map { it.agentOption() } }.getOrDefault(emptyList()) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    val data = loaded.value
    SubScreen(data?.skill?.name ?: "Skill", onBack, busy = writes.busy || loaded.loading, error = writes.error ?: loaded.error, onRetry = loaded::reload) {
        if (missing) EmptyState(ReiIcons.Sparkle, "This skill no longer exists")
        if (data != null) {
            val skill = data.skill
            SettingsGroup {
                SettingsRow(
                    skill.description.ifBlank { skill.name },
                    summary = if (skill.builtIn) "Built-in · Read-only" else skill.pluginName?.let { "Part of the plugin $it" + if (skill.pluginEnabled) "" else " (disabled)" } ?: "Standalone: no plugin owns it",
                    onClick = if (!skill.builtIn && skill.pluginId != null && onOpenPlugin != null) ({ onOpenPlugin(skill.pluginId) }) else null,
                    trailing = if (!skill.builtIn && skill.pluginId != null && onOpenPlugin != null) ({ SettingsChevron() }) else null,
                )
            }
            if (!data.current) {
                StatusBanner("Showing version ${data.version}. The current one is version ${skill.version}.", kind = StatusKind.Attention, actionLabel = "Back to current", onAction = { viewing = null })
            }
            if (data.current && !editing && !skill.builtIn) {
                FormGroup { FormButton("Edit SKILL.md", primary = false, enabled = !writes.busy && data.skillMd != null, onClick = { text = data.skillMd?.content.orEmpty(); editing = true }) }
            }
            val skillMd = data.skillMd
            if (editing && skillMd != null) {
                FormGroup(title = "SKILL.md", note = "The name can't change here. Saving makes a new version; the old one stays in the list.") {
                    ReiTextField(text, { text = it }, "SKILL.md", singleLine = false, minLines = 12, enabled = !writes.busy)
                    FormButton("Save", enabled = !writes.busy && text != skillMd.content, onClick = {
                        writes.run({ editing = false; loaded.reload() }) { api.request("PATCH", listOf("api", "skills", id), editBody(data.files, text)) }
                    })
                    FormButton("Cancel", primary = false, enabled = !writes.busy, onClick = { editing = false })
                }
            } else {
                SettingsGroup(title = "SKILL.md · v${data.version}") {
                    val md = skillMd
                    if (md == null) SettingsRow("This version has no SKILL.md.")
                    else {
                        val parts = splitSkillMd(md.content)
                        parts.fields.filter { it.first != "name" && it.first != "description" }.forEach { (key, value) -> SettingsRow(key, summary = value) }
                        Box(Modifier.padding(16.dp)) { ReiMarkdown(parts.body, api) }
                    }
                }
            }
            if (data.others.isNotEmpty()) {
                SettingsGroup(title = "Other files") {
                    data.others.forEachIndexed { index, file -> SkillFileRow(file, dividerBelow = index < data.others.lastIndex) }
                }
            }
            val options = agents.value.orEmpty()
            if (options.size > 1 && data.current && !skill.builtIn) {
                AgentAllow(options, skill.agents, enabled = !writes.busy) { body -> writes.run(loaded::reload) { api.request("PATCH", listOf("api", "skills", id), body) } }
            }
            SettingsGroup(title = "Versions") {
                data.versions.forEachIndexed { index, version ->
                    val isCurrent = version.version == skill.version
                    SettingsRow(
                        "Version ${version.version}" + if (isCurrent) " · Current" else "",
                        summary = listOfNotNull(
                            listOfNotNull(if (skill.builtIn) "Included with Rei" else if (version.author == "agent") "By an agent" else "By you", if (skill.builtIn) null else dateTime(version.createdAt)).joinToString(" · "),
                            version.note.takeIf { it.isNotBlank() },
                        ).joinToString("\n"),
                        dividerBelow = index < data.versions.lastIndex,
                        trailing = {
                            Row {
                                if (version.version != data.version) ReiIconButton(ReiIcons.Eye, "View version ${version.version}", { viewing = if (isCurrent) null else version.version })
                                if (!isCurrent && !skill.builtIn) ReiIconButton(ReiIcons.Undo, "Restore version ${version.version}", { writes.run({ viewing = null; loaded.reload() }) { api.request("PATCH", listOf("api", "skills", id), restoreBody(version.version)) } }, enabled = !writes.busy)
                            }
                        },
                    )
                }
            }
            if (!skill.builtIn) FormGroup { FormButton("Delete skill", primary = false, enabled = !writes.busy, onClick = { confirmDelete = true }) }
        }
    }
    if (confirmDelete && data != null) {
        ConfirmDialog(
            title = "Delete “${data.skill.name}”?",
            text = "This removes the skill and all its versions. Triggers that use it fail with a clear reason until you edit them.",
            confirmLabel = "Delete", destructive = true,
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
    SettingsRow(file.path, summary = if (open) (if (file.isText) file.content else "A binary file; it can't be shown here.") else null, onClick = { open = !open }, dividerBelow = dividerBelow, trailing = { Text(if (open) "Hide" else "View", color = MaterialTheme.colorScheme.primary) })
}

/** Which agents see the skill: all, or only the ones ticked. Shown only when there is more than one agent. */
@Composable
private fun AgentAllow(agents: List<AgentOption>, saved: List<String>?, enabled: Boolean, onSave: (JsonObject) -> Unit) {
    var only by remember(saved) { mutableStateOf(saved != null) }
    var picked by remember(saved) { mutableStateOf((saved ?: agents.map { it.id }).toSet()) }
    FormGroup(title = "Who can use it") {
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
        FormButton("Save", primary = false, enabled = enabled && agentsChanged(saved, only, picked), onClick = { onSave(agentsBody(only, picked, agents)) })
    }
}

@Composable
private fun ChoiceRowInline(only: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    ChoiceRow(
        "Available to", if (only) "some" else "all", listOf(Choice("all", "Every agent"), Choice("some", "Only some agents")),
        onSelect = { onChange(it == "some") }, enabled = enabled,
    )
}
