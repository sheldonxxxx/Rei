package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.obj
import dev.rei.android.ui.components.SettingsSwitchRow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Everything the page loads: the three settings documents the draft is made from. */
private data class RuntimeData(val context: JsonObject, val behavior: JsonObject, val standard: JsonObject) {
    val sections get() = runtimeSections(context, behavior)
    fun draft() = runtimeDraft(context, behavior, standard)
}

private suspend fun loadRuntime(api: ReiApi) = RuntimeData(
    context = api.request("GET", listOf("api", "settings", "context")),
    behavior = api.request("GET", listOf("api", "settings", "behavior")),
    standard = api.request("GET", listOf("api", "settings", "models")).obj("standard"),
)

/**
 * Runtime: summaries and memory, run limits, retries and timeouts, and tool search. One draft spans the three tabs and
 * saves together; reset restores every default.
 */
@Composable
fun RuntimeScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val data = rememberResource(api) { loadRuntime(api) }
    var tab by rememberSaveable { mutableStateOf(RuntimeTab.Context) }
    var draft by remember(data.value) { mutableStateOf(data.value?.draft()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val loaded = data.value
    SubScreen("Runtime", onBack, busy = writes.busy || data.loading, error = problem ?: writes.error ?: data.error, onRetry = data::reload) {
        val current = draft
        if (loaded != null && current != null) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                RuntimeTab.entries.forEach { FilterChip(tab == it, { tab = it }, { Text(it.label) }) }
            }
            loaded.sections.filter { it.tab == tab }.forEach { section ->
                FormGroup(title = section.title, note = section.blurb) {
                    section.switches.forEach { (flag, label) ->
                        SettingsSwitchRow(
                            label, current.flags[flag] ?: DefaultFlags.getValue(flag),
                            { on -> draft = current.copy(flags = current.flags + (flag to on)); saved = false },
                            enabled = !writes.busy,
                        )
                    }
                    section.fields.forEach { field ->
                        NumberField(
                            current.texts[field.key].orEmpty(),
                            { text -> draft = current.copy(texts = current.texts + (field.key to text)); saved = false },
                            field.label,
                            supportingText = "${field.help} Default: ${field.defaultText}.",
                            enabled = !writes.busy,
                        )
                    }
                }
            }
            FormGroup(note = if (saved) "Saved. Applies from the next model call." else null) {
                FormButton("Save settings", enabled = !writes.busy, onClick = {
                    when (val save = runtimeSave(loaded.sections, current, loaded.standard)) {
                        is RuntimeSave.Invalid -> { tab = save.tab; problem = save.message }
                        is RuntimeSave.Ready -> {
                            problem = null
                            writes.run({ saved = true; data.reload() }) {
                                api.request("PUT", listOf("api", "settings", "context"), save.context)
                                api.request("PUT", listOf("api", "settings", "behavior"), save.behavior)
                                if (save.timeouts != null) api.request("PUT", listOf("api", "settings", "models"), buildJsonObject { put("standard", save.timeouts) })
                            }
                        }
                    }
                })
                FormButton("Reset all to defaults", primary = false, enabled = !writes.busy, onClick = {
                    problem = null
                    writes.run({ saved = true; data.reload() }) {
                        api.request("PUT", listOf("api", "settings", "context"), buildJsonObject { put("compaction", JsonNull); put("home", JsonNull) })
                        api.request("PUT", listOf("api", "settings", "behavior"), runtimeResetBehavior(loaded.behavior))
                        api.request("PUT", listOf("api", "settings", "models"), buildJsonObject { put("standard", runtimeResetDeadlines()) })
                    }
                })
            }
        }
    }
}
