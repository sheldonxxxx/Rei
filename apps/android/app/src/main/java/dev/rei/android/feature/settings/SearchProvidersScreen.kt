package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.components.SettingsSwitchRow
import dev.rei.android.ui.icons.ReiIcons

/**
 * Web search: which providers agents try, in order, until one returns results. Keys are write-only: a typed key goes out
 * with the save and the field is empty again afterwards.
 */
@Composable
internal fun SearchProvidersScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val settings = rememberResource(api) { api.request("GET", listOf("api", "providers", "search-settings")) }
    var form by remember(settings.value) { mutableStateOf(settings.value?.let(::searchForm)) }
    var open by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    val current = form
    SubScreen("Web search", onBack, busy = writes.busy || settings.loading, error = problem ?: writes.error ?: settings.error, onRetry = settings::reload) {
        val loaded = settings.value
        if (current != null && loaded != null) {
            val busy = writes.busy
            val statuses = searchStatuses(loaded)
            val now = System.currentTimeMillis()
            val rows = searchRows(current.order)
            val ready = firstReady(current, statuses, now)
            val exaConfigured = current.exaAuth == "api_key" && statuses.any { it.id == "exa" && it.configured }
            SettingsGroup(title = "Search order") {
                SettingsRow("Enabled providers are tried from top to bottom. Search stops when one returns results.")
            }
            rows.forEachIndexed { index, option ->
                val id = providerOf(option)
                val status = statuses.firstOrNull { it.id == id }
                val configured = when {
                    id == "exa" -> option == "exa" || exaConfigured || current.keys["exa"].orEmpty().isNotBlank()
                    else -> status?.configured ?: false
                }
                val enabled = current.enabled(option)
                SettingsGroup {
                    SettingsSwitchRow(
                        searchName(option), enabled, { on -> form = current.toggled(option, on); notice = null },
                        icon = ReiIcons.Globe, enabled = !busy,
                        summary = listOfNotNull(searchState(configured, status, now), if (enabled && id == ready) "First available" else null).joinToString(" · "),
                    )
                    SettingsRow(
                        "Position ${index + 1} of ${rows.size}",
                        trailing = {
                          Row {
                            ReiIconButton(ReiIcons.Up, "Move ${searchName(option)} up", { form = current.copy(order = moveSearch(current.order, option, -1)); notice = "${searchName(option)} moved. Save to apply." }, enabled = !busy && index > 0)
                            ReiIconButton(ReiIcons.Down, "Move ${searchName(option)} down", { form = current.copy(order = moveSearch(current.order, option, 1)); notice = "${searchName(option)} moved. Save to apply." }, enabled = !busy && index < rows.lastIndex)
                            if (option != "exa") ReiIconButton(ReiIcons.Settings, "Configure ${searchName(option)}", { open = if (open == option) null else option })
                          }
                        },
                    )
                    if (open == option) {
                        FormGroup(note = "Configuration does not turn this provider on. Credentials stay in the gateway.") {
                            if (id == "codex-subscription") {
                                ReiTextField(
                                    current.codexModel, { form = current.copy(codexModel = it.take(100)) }, "Search model", enabled = !busy,
                                    supportingText = "Uses your OpenAI connection signed in with ChatGPT. The model must support web search on your account.",
                                )
                            }
                            if (id == "searxng") {
                                ReiTextField(current.searxngUrl, { form = current.copy(searxngUrl = it) }, "SearXNG URL", placeholder = "https://search.example.com", enabled = !busy)
                            }
                            if (id != "codex-subscription" && !(id == "exa" && option != "exa-api")) {
                                SecretField(
                                    current.keys[id].orEmpty(), { form = current.copy(keys = current.keys + (id to it)); notice = null },
                                    if (id == "searxng") "Authentication (optional)" else "${searchName(id)} API key",
                                    placeholder = "Leave blank to keep a saved credential", enabled = !busy,
                                )
                            }
                        }
                    }
                }
            }
            FormGroup(note = notice ?: "Queries may go to each enabled provider until one succeeds. Providers that need setup or are rate limited are skipped. Turn every provider off to disable search.") {
                FormButton("Save changes", enabled = !busy, onClick = {
                    when (val save = searchSave(current)) {
                        is SearchSave.Invalid -> problem = save.message
                        is SearchSave.Ready -> {
                            problem = null
                            writes.run({ notice = "Saved"; settings.reload() }) { api.request("POST", listOf("api", "providers", "search-settings"), save.body) }
                        }
                    }
                })
            }
        }
    }
}
