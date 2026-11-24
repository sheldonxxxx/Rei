package dev.rei.android.feature.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.rei.android.data.ReiApi
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
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
fun MemoryScreen(api: ReiApi, onOpenActivity: () -> Unit, onOpenHistory: (String) -> Unit, onBack: () -> Unit) {
    MemoryList(api, onOpenActivity, onBack, onOpenHistory)
}

@Composable
private fun MemoryList(api: ReiApi, onOpenActivity: () -> Unit, onBack: () -> Unit, onHistory: (String) -> Unit) {
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

    SubScreen("Memory", onBack, busy = writes.busy || memory.loading, error = writes.error ?: memory.error, onRetry = memory::reload) {
        SettingsGroup {
            SettingsRow(
                "Memory review", icon = ReiIcons.Activity, summary = "See what Rei saved from your chats, and undo it.",
                onClick = onOpenActivity, trailing = { SettingsChevron() },
            )
        }
        memory.value?.forEach { doc ->
            val title = if (doc.agentId == null) "About you" else "${names.value?.get(doc.agentId) ?: "Agent"}’s notes"
            SettingsGroup(title = title) {
                if (doc.entries.isEmpty()) {
                    SettingsRow(if (doc.agentId == null) "Nothing yet." else "No notes yet.", dividerBelow = true)
                }
                doc.entries.forEach { entry ->
                    SettingsRow(
                        entry.text,
                        summary = dateTime(entry.confirmedAt)?.let { "Confirmed $it" },
                        onClick = { sheet = entry },
                        dividerBelow = true,
                        tabularSummary = true,
                    )
                }
                SettingsRow(
                    "Add entry", icon = ReiIcons.Plus,
                    onClick = { adding = doc },
                    modifier = androidx.compose.ui.Modifier.androidAddLabel(title),
                )
            }
        }
        if (memory.value?.all { it.entries.isEmpty() } == true && memory.error == null) {
            EmptyState(ReiIcons.Memory, "Nothing remembered yet", body = "Entries you add, and ones Rei saves from your chats, appear here.")
        }
    }
    sheet?.let { entry ->
        ReiSheet(onDismiss = { sheet = null }, title = entry.text.take(60)) {
            SettingsRow("Edit", icon = ReiIcons.Edit, onClick = { sheet = null; editing = entry })
            SettingsRow("History", icon = ReiIcons.History, onClick = { sheet = null; onHistory(entry.id) })
            SettingsRow("Remove", icon = ReiIcons.Trash, destructive = true, onClick = { sheet = null; removing = entry })
        }
    }
    editing?.let { entry ->
        TextEditDialog(
            title = "Edit memory entry", label = "Entry", initial = entry.text, limit = 500, singleLine = false,
            onDismiss = { editing = null },
            onSave = { text ->
                editing = null
                writes.run(memory::reload) { api.request("PATCH", listOf("api", "memory", "lines", entry.id), buildJsonObject { put("text", text) }) }
            },
        )
    }
    adding?.let { doc ->
        TextEditDialog(
            title = "Add memory entry", label = "Entry", initial = "", limit = 500, singleLine = false, saveLabel = "Add",
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
            title = "Remove this entry?",
            text = entry.text,
            confirmLabel = "Remove",
            destructive = true,
            onConfirm = {
                removing = null
                writes.run(memory::reload) {
                    val change = api.request("DELETE", listOf("api", "memory", "lines", entry.id)).obj("change").string("id")
                    notices?.show("Entry removed", "Undo") {
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

private fun androidx.compose.ui.Modifier.androidAddLabel(group: String) =
    this.then(androidx.compose.ui.Modifier.semantics { contentDescription = "Add an entry to $group" })

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
    SubScreen("Entry history", onBack, busy = writes.busy || edits.loading, error = writes.error ?: edits.error, onRetry = edits::reload) {
        val list = edits.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.History, "No edits recorded", body = "Changes to this entry appear here.")
            else -> SettingsGroup {
                list.forEachIndexed { index, edit ->
                    SettingsRow(
                        title = "${verb(edit.op)} · ${if (edit.by == "agent") "Rei" else "You"}",
                        summary = listOfNotNull(
                            dateTime(edit.at),
                            edit.before?.let { "Before: $it" },
                            edit.after?.let { "After: $it" },
                            if (edit.undone) "Undone" else null,
                        ).joinToString("\n"),
                        dividerBelow = index < list.lastIndex,
                        tabularSummary = true,
                        trailing = if (edit.undoable && !edit.undone) {
                            {
                                androidx.compose.material3.TextButton(
                                    onClick = { writes.run(edits::reload) { api.request("POST", listOf("api", "memory", "changes", edit.id, "undo")) } },
                                    enabled = !writes.busy,
                                ) { androidx.compose.material3.Text("Undo") }
                            }
                        } else null,
                    )
                }
            }
        }
    }
}

internal fun verb(op: String) = when (op) {
    "add" -> "Added"
    "replace" -> "Changed"
    "remove" -> "Removed"
    else -> "Confirmed"
}
