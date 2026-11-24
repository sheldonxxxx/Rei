package dev.rei.android.feature.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal data class MemoryEntry(val id: String, val text: String, val confirmedAt: Long?)

/** One memory document: the profile (`agentId` null) or an agent's notes. */
internal data class MemoryDoc(val agentId: String?, val entries: List<MemoryEntry>)

private fun JsonObject.entries() = objects("lines")
private fun List<JsonObject>.toEntries() = map { MemoryEntry(it.string("id"), it.string("text"), it.optionalString("confirmedAt")?.toLongOrNull()) }

internal fun parseMemory(body: JsonObject): List<MemoryDoc> =
    listOf(MemoryDoc(null, body.objects("profile").toEntries())) +
        body.objects("agents").map { MemoryDoc(it.string("agentId"), it.entries().toEntries()) }

/** One edit in an entry's history. */
internal data class MemoryEdit(val id: String, val op: String, val by: String, val at: Long?, val before: String?, val after: String?, val undoable: Boolean, val undone: Boolean)

/**
 * Memory: what Rei keeps about you and each agent's notes. Add, edit, remove (with Undo), per-entry history with Undo, and a
 * link to Memory review in Background Activity.
 */
@Composable
fun MemoryScreen(
    api: ReiApi,
    onOpenActivity: () -> Unit,
    onOpenHistory: (String) -> Unit,
    onBack: () -> Unit,
    onOpenReviewSettings: (() -> Unit)? = null,
) {
    MemoryList(api, onOpenActivity, onBack, onOpenHistory, onOpenReviewSettings)
}

@Composable
private fun MemoryList(
    api: ReiApi,
    onOpenActivity: () -> Unit,
    onBack: () -> Unit,
    onHistory: (String) -> Unit,
    onOpenReviewSettings: (() -> Unit)?,
) {
    val resources = LocalResources.current
    val notices = LocalNotices.current
    val writes = rememberWrites()
    val memory = rememberResource(api) { parseMemory(api.request("GET", listOf("api", "memory"))) }
    val names = rememberResource(api) {
        suspendRunCatching { api.request("GET", listOf("api", "agents")).objects("agents").associate { it.string("id") to it.string("name") } }.getOrDefault(emptyMap())
    }
    var sheet by remember { mutableStateOf<MemoryEntry?>(null) }
    var editing by remember { mutableStateOf<MemoryEntry?>(null) }
    var removing by remember { mutableStateOf<MemoryEntry?>(null) }
    var adding by remember { mutableStateOf<MemoryDoc?>(null) }

    SubScreen(stringResource(R.string.settings_page_memory), onBack, busy = writes.busy || memory.loading, error = writes.error ?: memory.error, onRetry = memory::reload) {
        SettingsGroup {
            SettingsRow(
                stringResource(R.string.activity_kind_memory_review), icon = ReiIcons.Activity, summary = stringResource(R.string.settings_memory_review_summary),
                dividerBelow = onOpenReviewSettings != null,
                onClick = onOpenActivity, trailing = { SettingsChevron() },
            )
            if (onOpenReviewSettings != null) {
                SettingsRow(
                    stringResource(R.string.settings_memory_bg_settings), icon = ReiIcons.Settings, summary = stringResource(R.string.settings_memory_bg_settings_summary),
                    onClick = onOpenReviewSettings, trailing = { SettingsChevron() },
                )
            }
        }
        memory.value?.forEach { doc ->
            val title = if (doc.agentId == null) {
                stringResource(R.string.settings_memory_about_you)
            } else {
                stringResource(R.string.settings_memory_agent_notes, names.value?.get(doc.agentId) ?: stringResource(R.string.settings_memory_agent_fallback))
            }
            SettingsGroup(title = title) {
                if (doc.entries.isEmpty()) {
                    SettingsRow(stringResource(if (doc.agentId == null) R.string.settings_memory_nothing_yet else R.string.settings_memory_no_notes), dividerBelow = true)
                }
                doc.entries.forEach { entry ->
                    SettingsRow(
                        entry.text,
                        summary = dateTime(entry.confirmedAt)?.let { stringResource(R.string.settings_memory_confirmed_at, it) },
                        onClick = { sheet = entry },
                        dividerBelow = true,
                        tabularSummary = true,
                    )
                }
                SettingsRow(
                    stringResource(R.string.settings_memory_add_entry), icon = ReiIcons.Plus,
                    onClick = { adding = doc },
                    modifier = androidx.compose.ui.Modifier.androidAddLabel(stringResource(R.string.settings_memory_add_to_group, title)),
                )
            }
        }
        if (memory.value?.all { it.entries.isEmpty() } == true && memory.error == null) {
            EmptyState(ReiIcons.Memory, stringResource(R.string.settings_memory_empty_title), body = stringResource(R.string.settings_memory_empty_body))
        }
    }
    sheet?.let { entry ->
        ReiSheet(onDismiss = { sheet = null }, title = entry.text.take(60)) {
            SettingsRow(stringResource(R.string.knowledge_page_edit), icon = ReiIcons.Edit, onClick = { sheet = null; editing = entry })
            SettingsRow(stringResource(R.string.viewer_history), icon = ReiIcons.History, onClick = { sheet = null; onHistory(entry.id) })
            SettingsRow(stringResource(R.string.settings_passkeys_remove), icon = ReiIcons.Trash, destructive = true, onClick = { sheet = null; removing = entry })
        }
    }
    editing?.let { entry ->
        TextEditDialog(
            title = stringResource(R.string.settings_memory_edit_title), label = stringResource(R.string.settings_memory_entry_label), initial = entry.text, limit = 500, singleLine = false,
            onDismiss = { editing = null },
            onSave = { text ->
                editing = null
                writes.run(memory::reload) { api.request("PATCH", listOf("api", "memory", "lines", entry.id), buildJsonObject { put("text", text) }) }
            },
        )
    }
    adding?.let { doc ->
        TextEditDialog(
            title = stringResource(R.string.settings_memory_add_title), label = stringResource(R.string.settings_memory_entry_label), initial = "", limit = 500, singleLine = false, saveLabel = stringResource(R.string.knowledge_page_add),
            onDismiss = { adding = null },
            onSave = { text ->
                adding = null
                writes.run(memory::reload) {
                    api.request("POST", listOf("api", "memory", "lines"), buildJsonObject {
                        put("doc", if (doc.agentId == null) "profile" else "agent")
                        if (doc.agentId != null) put("agentId", doc.agentId)
                        put("text", text)
                    })
                }
            },
        )
    }
    removing?.let { entry ->
        ConfirmDialog(
            title = stringResource(R.string.settings_memory_remove_title),
            text = entry.text,
            confirmLabel = stringResource(R.string.settings_passkeys_remove),
            destructive = true,
            onConfirm = {
                removing = null
                writes.run(memory::reload) {
                    val change = api.request("DELETE", listOf("api", "memory", "lines", entry.id)).obj("change").string("id")
                    notices?.show(resources.getString(R.string.settings_memory_entry_removed), resources.getString(R.string.activity_undo)) {
                        notices.launch {
                            suspendRunCatching { api.request("POST", listOf("api", "memory", "changes", change, "undo")) }
                            memory.reload()
                        }
                    }
                }
            },
            onDismiss = { removing = null },
        )
    }
}

private fun androidx.compose.ui.Modifier.androidAddLabel(label: String) =
    this.then(androidx.compose.ui.Modifier.semantics { contentDescription = label })

@Composable
fun MemoryHistory(api: ReiApi, lineId: String, onBack: () -> Unit) {
    val writes = rememberWrites()
    val edits = rememberResource(lineId) {
        api.request("GET", listOf("api", "memory", "lines", lineId, "changes")).objects("changes").map {
            MemoryEdit(
                it.string("id"), it.string("op"), it.string("by"), it.optionalString("at")?.toLongOrNull(), it.optionalString("before"), it.optionalString("after"),
                it.optionalString("undoable") == "true", it.optionalString("undoneAt") != null,
            )
        }.asReversed()
    }
    SubScreen(stringResource(R.string.settings_memory_history_title), onBack, busy = writes.busy || edits.loading, error = writes.error ?: edits.error, onRetry = edits::reload) {
        val list = edits.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.History, stringResource(R.string.settings_memory_history_empty_title), body = stringResource(R.string.settings_memory_history_empty_body))
            else -> SettingsGroup {
                list.forEachIndexed { index, edit ->
                    val by = stringResource(if (edit.by == "agent") R.string.app_name else R.string.settings_memory_by_you)
                    SettingsRow(
                        title = stringResource(R.string.settings_memory_history_row_title, verb(edit.op).asString(), by),
                        summary = listOfNotNull(
                            dateTime(edit.at),
                            edit.before?.let { stringResource(R.string.settings_memory_before, it) },
                            edit.after?.let { stringResource(R.string.settings_memory_after, it) },
                            if (edit.undone) stringResource(R.string.activity_undone) else null,
                        ).joinToString("\n"),
                        dividerBelow = index < list.lastIndex,
                        tabularSummary = true,
                        trailing = if (edit.undoable && !edit.undone) {
                            {
                                androidx.compose.material3.TextButton(
                                    onClick = { writes.run(edits::reload) { api.request("POST", listOf("api", "memory", "changes", edit.id, "undo")) } },
                                    enabled = !writes.busy,
                                ) { androidx.compose.material3.Text(stringResource(R.string.activity_undo)) }
                            }
                        } else null,
                    )
                }
            }
        }
    }
}

internal fun verb(op: String): UiText = when (op) {
    "add" -> UiText.Resource(R.string.settings_memory_verb_add)
    "replace" -> UiText.Resource(R.string.settings_memory_verb_replace)
    "remove" -> UiText.Resource(R.string.settings_memory_verb_remove)
    else -> UiText.Resource(R.string.settings_memory_verb_confirm)
}
