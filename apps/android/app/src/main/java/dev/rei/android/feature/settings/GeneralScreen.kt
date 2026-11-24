package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ModelCatalog
import dev.rei.android.data.ReiApi
import dev.rei.android.data.models
import dev.rei.android.data.obj
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.data.suspendRunCatching
import dev.rei.android.ui.components.PillField
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.JsonNull
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.ZoneId

/** The chat-title choice that means "no model: use the first message", as the web's select does. */
internal const val TitlesOff = "\u0000off"

/** The chat-title choice that means "the server's default title model". */
internal const val TitlesDefault = ""

/** What the title select shows for the server's settings: Off, the default model, or one model. */
internal fun titleSelection(enabled: Boolean, model: String?): String = if (!enabled) TitlesOff else model ?: TitlesDefault

/** The `PUT /api/settings/titles` body for a choice. */
internal fun titleUpdate(choice: String): JsonObject = buildJsonObject {
    if (choice == TitlesOff) put("enabled", false)
    else {
        put("enabled", true)
        if (choice == TitlesDefault) put("model", JsonNull) else put("model", choice)
    }
}

/** The zones to offer: every zone the device knows plus the device's own, the saved one and UTC, sorted and unique. */
internal fun timeZoneOptions(known: Collection<String>, device: String?, saved: String?): List<String> =
    (known + listOfNotNull(device, "UTC", saved)).filter { it.isNotBlank() }.toSortedSet().toList()

/** Zones whose name contains every word of [query], ignoring case and treating `_` as a space. */
internal fun filterZones(zones: List<String>, query: String): List<String> {
    val words = query.lowercase().split(' ').filter { it.isNotEmpty() }
    if (words.isEmpty()) return zones
    return zones.filter { zone -> val name = zone.lowercase().replace('_', ' '); words.all { it in name } }
}

private data class GeneralData(
    val timeZone: String?,
    val titlesEnabled: Boolean,
    val titleModel: String?,
    val titleDefault: String,
    val catalog: ModelCatalog?,
    val agents: List<Pair<String, String>>,
    val companionAgent: String?,
    val reviewEnabled: Boolean,
    val reviewEvery: Int,
)

private suspend fun loadGeneral(api: ReiApi): GeneralData = coroutineScope {
    val zoneJob = async { api.request("GET", listOf("api", "settings", "time-zone")) }
    val titlesJob = async { api.request("GET", listOf("api", "settings", "titles")) }
    val agentsJob = async { api.request("GET", listOf("api", "agents")) }
    val reviewJob = async { api.request("GET", listOf("api", "settings", "memory-extraction")) }
    val catalogJob = async { suspendRunCatching { api.models() }.getOrNull() }
    val zone = zoneJob.await()
    val titles = titlesJob.await()
    val agents = agentsJob.await()
    val review = reviewJob.await()
    GeneralData(
        timeZone = zone.optionalString("timeZone"),
        titlesEnabled = titles.optionalString("enabled") == "true",
        titleModel = titles.optionalString("model"),
        titleDefault = titles.optionalString("default").orEmpty(),
        catalog = catalogJob.await(),
        agents = agents.objects("agents").map { it.string("id") to it.string("name") },
        companionAgent = (agents["companion"] as? JsonObject)?.optionalString("agentId"),
        reviewEnabled = review.optionalString("enabled") == "true",
        reviewEvery = review.optionalString("everyNTurns")?.toIntOrNull() ?: 5,
    )
}

/**
 * General: time zone, who writes chat titles, the companion agent, background memory review and two-factor sign-in. Appearance,
 * notifications, devices and passkeys have their own rows on the index.
 */
@Composable
fun GeneralScreen(api: ReiApi, onBack: () -> Unit) {
    GeneralMain(api, onBack)
}

@Composable
private fun GeneralMain(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val data = rememberResource(api) { loadGeneral(api) }
    var zones by remember { mutableStateOf(false) }
    var cadence by remember(data.value?.reviewEvery) { mutableStateOf(data.value?.reviewEvery?.toString().orEmpty()) }
    var cadenceError by remember { mutableStateOf<String?>(null) }
    SubScreen("General", onBack, busy = writes.busy || data.loading, error = writes.error ?: data.error, onRetry = data::reload) {
        val loaded = data.value
        if (loaded != null) {
            SettingsGroup(title = "Date and time") {
                SettingsRow(
                    "Time zone", icon = ReiIcons.Clock, summary = (loaded.timeZone ?: "Not set") + "\nSets today’s date and clock times for the agent.",
                    onClick = { zones = true }, trailing = { SettingsChevron() },
                )
            }
            val models = loaded.catalog?.models.orEmpty()
            val titleChoices = buildList {
                add(Choice(TitlesOff, "Off: use the first message"))
                val defaultReady = loaded.titleDefault in models
                add(Choice(TitlesDefault, if (defaultReady) "Default (${loaded.catalog?.label(loaded.titleDefault)})" else "Default unavailable", enabled = defaultReady))
                if (loaded.titleModel != null && loaded.titleModel !in models) add(Choice(loaded.titleModel, "Current model unavailable", enabled = false))
                models.forEach { add(Choice(it, loaded.catalog?.label(it) ?: it)) }
            }
            SettingsGroup(title = "Chats") {
                ChoiceRow(
                    "Chat titles", titleSelection(loaded.titlesEnabled, loaded.titleModel), titleChoices, icon = ReiIcons.Edit,
                    enabled = !writes.busy, dividerBelow = true,
                    onSelect = { choice -> writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "titles"), titleUpdate(choice)) } },
                )
                ChoiceRow(
                    "Companion", loaded.companionAgent, loaded.agents.map { Choice(it.first, it.second) }, icon = ReiIcons.Chat,
                    summary = "The agent that widgets and quick messages from other devices go to.",
                    enabled = !writes.busy && loaded.agents.isNotEmpty(),
                    onSelect = { id -> writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "companion"), buildJsonObject { put("agentId", id) }) } },
                )
            }
            SettingsGroup(title = "Memory") {
                SettingsSwitchRow(
                    "Background memory review", loaded.reviewEnabled,
                    { on -> writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "memory-extraction"), buildJsonObject { put("enabled", on) }) } },
                    icon = ReiIcons.Memory, enabled = !writes.busy,
                    summary = "Off by default. Rei privately reviews each chat after the chosen number of completed replies and saves only durable information supported by your new messages. A review can finish with no changes, or add, update or remove unprotected memory. Counting starts when enabled; earlier messages are not backfilled. Each review uses the source reply’s model and adds token cost.",
                )
            }
            FormGroup {
                NumberField(
                    cadence, { cadence = it; cadenceError = null }, "Replies between reviews",
                    supportingText = "Global setting for all agents. Each chat keeps its own count. Default 5; choose 2–100.",
                    error = cadenceError, enabled = !writes.busy,
                )
                FormButton("Save review interval", enabled = !writes.busy && cadence != loaded.reviewEvery.toString(), onClick = {
                    val n = parseWholeNumber(cadence, 2, 100)
                    if (n == null) cadenceError = "Choose a whole number from 2 to 100."
                    else writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "memory-extraction"), buildJsonObject { put("everyNTurns", n) }) }
                })
            }
        }
    }
    val loaded = data.value
    if (zones && loaded != null) {
        TimeZoneSheet(
            options = timeZoneOptions(ZoneId.getAvailableZoneIds(), ZoneId.systemDefault().id, loaded.timeZone),
            selected = loaded.timeZone,
            device = ZoneId.systemDefault().id,
            onDismiss = { zones = false },
            onPick = { zone ->
                zones = false
                writes.run(data::reload) { api.request("PUT", listOf("api", "settings", "time-zone"), buildJsonObject { put("timeZone", zone) }) }
            },
        )
    }
}

@Composable
private fun TimeZoneSheet(options: List<String>, selected: String?, device: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val shown = filterZones(options, query)
    ReiSheet(onDismiss = onDismiss, title = "Time zone") {
        Column(Modifier.padding(horizontal = 16.dp)) {
            PillField(query, { query = it }, "Search time zones", leadingIcon = ReiIcons.Search)
        }
        SettingsRow("Use this device’s zone", summary = device, onClick = { onPick(device) })
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp)) {
            items(shown, key = { it }) { zone ->
                SettingsRow(zone, onClick = { onPick(zone) }, trailing = if (zone == selected) ({ androidx.compose.material3.Icon(ReiIcons.Check, contentDescription = "Selected", tint = androidx.compose.material3.MaterialTheme.colorScheme.primary) }) else null)
            }
        }
    }
}
