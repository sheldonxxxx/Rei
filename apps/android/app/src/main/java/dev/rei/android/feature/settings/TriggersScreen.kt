package dev.rei.android.feature.settings

import androidx.compose.material3.Switch
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.objects
import dev.rei.android.data.obj
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
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
    val summary: UiText get() {
        val statusPart: UiText? = when (status) {
            "paused" -> UiText.Resource(if (pausedReason == "failures") R.string.settings_triggers_paused_failures else R.string.settings_triggers_paused)
            "done" -> UiText.Resource(R.string.settings_triggers_done)
            else -> dateTime(nextRunAt)?.let { UiText.Resource(R.string.settings_triggers_next, it) }
        }
        val start = startText.takeIf { it.isNotBlank() }
        return when {
            start != null && statusPart != null -> UiText.Resource(R.string.settings_triggers_summary_pair, start, statusPart)
            start != null -> UiText.Literal(start)
            statusPart != null -> statusPart
            else -> UiText.Literal("")
        }
    }
}

internal data class RunItem(val id: String, val status: String, val scheduledAt: Long?, val report: String?, val reason: String?)

private fun JsonObject.trigger() = TriggerItem(string("id"), string("name"), string("status"), optionalString("startText").orEmpty(), optionalString("nextRunAt")?.toLongOrNull(), optionalString("pausedReason"))

internal fun statusLabel(status: String): UiText = when (status) {
    "succeeded" -> UiText.Resource(R.string.settings_triggers_status_succeeded)
    "failed" -> UiText.Resource(R.string.settings_triggers_status_failed)
    "waiting" -> UiText.Resource(R.string.settings_triggers_status_waiting)
    "no_changes" -> UiText.Resource(R.string.settings_triggers_status_no_changes)
    "running" -> UiText.Resource(R.string.chat_run_running)
    "queued" -> UiText.Resource(R.string.chat_run_queued)
    "cancelled" -> UiText.Resource(R.string.chat_run_cancelled)
    else -> UiText.Literal(status.replace('_', ' ').replaceFirstChar { it.uppercase() })
}

/** Triggers: your agents' scheduled and event-driven work. Switch one on or off; open one for recent runs and Run now. */
@Composable
fun TriggersScreen(api: ReiApi, onOpenTrigger: (String) -> Unit, onBack: () -> Unit) {
    TriggerList(api, onBack, onOpenTrigger)
}

private fun pauseBody(active: Boolean) = buildJsonObject { put("paused", active) }

@Composable
private fun TriggerList(api: ReiApi, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val writes = rememberWrites()
    val triggers = rememberResource("triggers.list", api) { api.request("GET", listOf("api", "triggers")).objects("triggers").map { it.trigger() } }
    SubScreen(stringResource(R.string.settings_page_triggers), onBack, busy = writes.busy || triggers.loading, error = writes.error ?: triggers.error, onRetry = triggers::reload) {
        val list = triggers.value
        when {
            list == null -> Unit
            list.isEmpty() -> EmptyState(ReiIcons.Clock, stringResource(R.string.settings_triggers_empty_title), body = stringResource(R.string.settings_triggers_empty_body))
            else -> SettingsGroup {
                list.forEachIndexed { index, item ->
                    val switchCd = stringResource(R.string.settings_triggers_enabled_cd, item.name)
                    SettingsRow(
                        item.name, icon = ReiIcons.Clock, summary = item.summary.asString().takeIf { it.isNotEmpty() }, onClick = { onOpen(item.id) },
                        dividerBelow = index < list.lastIndex,
                        trailing = {
                            Switch(
                                checked = item.active,
                                onCheckedChange = { writes.run(triggers::reload) { api.request("PATCH", listOf("api", "triggers", item.id), pauseBody(item.active)) } },
                                enabled = item.canToggle && !writes.busy,
                                modifier = Modifier.semantics { contentDescription = switchCd },
                            )
                        },
                    )
                }
            }
        }
    }
}

@Composable
fun TriggerDetail(api: ReiApi, id: String, onBack: () -> Unit) {
    val writes = rememberWrites()
    val path = listOf("api", "triggers", id)
    val detail = rememberResource("triggers.detail", id) {
        val body = api.request("GET", path)
        body.obj("trigger").trigger() to body.objects("runs").map {
            RunItem(it.string("id"), it.string("status"), it.optionalString("scheduledAt")?.toLongOrNull(), it.optionalString("report"), it.optionalString("reason"))
        }
    }
    var renaming by remember { mutableStateOf(false) }
    var running by remember { mutableStateOf(false) }
    val trigger = detail.value?.first
    SubScreen(trigger?.name ?: stringResource(R.string.settings_triggers_single), onBack, busy = writes.busy || detail.loading, error = writes.error ?: detail.error, onRetry = detail::reload) {
        if (trigger != null) {
            SettingsGroup {
                SettingsSwitchRow(
                    stringResource(R.string.settings_tfa_enabled), trigger.active, { writes.run(detail::reload) { api.request("PATCH", path, pauseBody(trigger.active)) } },
                    icon = ReiIcons.Clock, summary = trigger.summary.asString().takeIf { it.isNotEmpty() }, enabled = trigger.canToggle && !writes.busy, dividerBelow = true,
                )
                SettingsRow(stringResource(R.string.drawer_chat_rename), icon = ReiIcons.Edit, onClick = { renaming = true }, dividerBelow = trigger.active)
                if (trigger.active) SettingsRow(stringResource(R.string.settings_triggers_run_now), icon = ReiIcons.Send, onClick = { running = true })
            }
            val runs = detail.value?.second.orEmpty()
            SettingsGroup(title = stringResource(R.string.settings_triggers_recent_runs)) {
                if (runs.isEmpty()) SettingsRow(stringResource(R.string.settings_triggers_no_runs))
                runs.forEachIndexed { index, run ->
                    SettingsRow(
                        title = listOfNotNull(statusLabel(run.status).asString(), dateTime(run.scheduledAt)).joinToString(" · "),
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
            title = stringResource(R.string.settings_triggers_rename_title), label = stringResource(R.string.settings_triggers_name_label), initial = trigger.name, limit = 80,
            onDismiss = { renaming = false },
            onSave = { name -> renaming = false; writes.run(detail::reload) { api.request("PATCH", path, buildJsonObject { put("name", name) }) } },
        )
    }
    if (running && trigger != null) {
        ConfirmDialog(
            title = stringResource(R.string.settings_triggers_run_confirm_title, trigger.name),
            text = stringResource(R.string.settings_triggers_run_confirm_body),
            confirmLabel = stringResource(R.string.settings_triggers_run_now),
            onConfirm = { running = false; writes.run(detail::reload) { api.request("POST", path + "run") } },
            onDismiss = { running = false },
        )
    }
}
