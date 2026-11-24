package dev.rei.android.feature.settings

import androidx.activity.compose.BackHandler
import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.obj
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal data class TriggerItem(val id: String, val name: String, val status: String, val startText: String, val nextRunAt: Long?, val pausedReason: String?) {
    val active get() = status == "active"
    val canToggle get() = status == "active" || status == "paused"
    val summary get() = listOfNotNull(
        startText.takeIf { it.isNotBlank() },
        when (status) {
            "paused" -> if (pausedReason == "failures") "Paused after failures" else "Paused"
            "done" -> "Done"
            else -> dateTime(nextRunAt)?.let { "Next: $it" }
        },
    ).joinToString(" · ")
}

internal data class RunItem(val id: String, val status: String, val scheduledAt: Long?, val report: String?, val reason: String?)

private fun JsonObject.trigger() = TriggerItem(string("id"), string("name"), string("status"), optionalString("startText").orEmpty(), optionalString("nextRunAt")?.toLongOrNull(), optionalString("pausedReason"))

internal fun statusLabel(status: String) = status.replace('_', ' ').replaceFirstChar { it.uppercase() }

/** Triggers: your agents' scheduled and event-driven work. Switch one on or off; open one for recent runs and Run now. */
@Composable
fun TriggersScreen(api: ReiApi, onBack: () -> Unit) {
    var openId by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(openId != null) { openId = null }
    val id = openId
    if (id != null) TriggerDetail(api, id) { openId = null } else TriggerList(api, onBack) { openId = it }
}

private fun pauseBody(active: Boolean) = buildJsonObject { put("paused", active) }

@Composable
private fun TriggerList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val writes = rememberWrites()
    val triggers = rememberResource(api) { api.request("GET", listOf("api", "triggers")).objects("triggers").map { it.trigger() } }
    SubScreen("Triggers", onBack, busy = writes.busy || triggers.loading, error = writes.error ?: triggers.error, onRetry = triggers::reload) {
        val list = triggers.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.Clock, "No triggers", body = "Ask an agent in chat to run something on a schedule or when an event arrives.")
            else -> SettingsGroup {
                list.forEachIndexed { index, item ->
                    SettingsRow(
                        item.name, icon = ReiIcons.Clock, summary = item.summary, onClick = { onOpen(item.id) },
                        dividerBelow = index < list.lastIndex,
                        trailing = {
                            Switch(
                                checked = item.active,
                                onCheckedChange = { writes.run(triggers::reload) { api.request("PATCH", listOf("api", "triggers", item.id), pauseBody(item.active)) } },
                                enabled = item.canToggle && !writes.busy,
                                modifier = Modifier.semantics { contentDescription = "${item.name} enabled" },
                            )
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun TriggerDetail(api: ReiApi, id: String, onBack: () -> Unit) {
    val writes = rememberWrites()
    val path = listOf("api", "triggers", id)
    val detail = rememberResource(id) {
        val body = api.request("GET", path)
        body.obj("trigger").trigger() to body.objects("runs").map {
            RunItem(it.string("id"), it.string("status"), it.optionalString("scheduledAt")?.toLongOrNull(), it.optionalString("report"), it.optionalString("reason"))
        }
    }
    var renaming by remember { mutableStateOf(false) }
    var running by remember { mutableStateOf(false) }
    val trigger = detail.value?.first
    SubScreen(trigger?.name ?: "Trigger", onBack, busy = writes.busy || detail.loading, error = writes.error ?: detail.error, onRetry = detail::reload) {
        if (trigger != null) {
            SettingsGroup {
                SettingsSwitchRow(
                    "Enabled", trigger.active, { writes.run(detail::reload) { api.request("PATCH", path, pauseBody(trigger.active)) } },
                    icon = ReiIcons.Clock, summary = trigger.summary, enabled = trigger.canToggle && !writes.busy, dividerBelow = true,
                )
                SettingsRow("Rename", icon = ReiIcons.Edit, onClick = { renaming = true }, dividerBelow = trigger.active)
                if (trigger.active) SettingsRow("Run now", icon = ReiIcons.Send, onClick = { running = true })
            }
            val runs = detail.value?.second.orEmpty()
            SettingsGroup(title = "Recent runs") {
                if (runs.isEmpty()) SettingsRow("No runs yet")
                runs.forEachIndexed { index, run ->
                    SettingsRow(
                        title = listOfNotNull(statusLabel(run.status), dateTime(run.scheduledAt)).joinToString(" · "),
                        summary = run.report ?: run.reason,
                        dividerBelow = index < runs.lastIndex,
                        tabularSummary = true,
                    )
                }
            }
        }
    }
    if (renaming && trigger != null) {
        TextEditDialog(
            title = "Rename trigger", label = "Name", initial = trigger.name, limit = 80,
            onDismiss = { renaming = false },
            onSave = { name -> renaming = false; writes.run(detail::reload) { api.request("PATCH", path, buildJsonObject { put("name", name) }) } },
        )
    }
    if (running && trigger != null) {
        ConfirmDialog(
            title = "Run ${trigger.name} now?",
            text = "The agent starts this trigger’s work immediately, in addition to its schedule.",
            confirmLabel = "Run now",
            onConfirm = { running = false; writes.run(detail::reload) { api.request("POST", path + "run") } },
            onDismiss = { running = false },
        )
    }
}
