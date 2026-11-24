package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.UiText
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
    var notice by remember { mutableStateOf<UiText?>(null) }
    var problem by remember { mutableStateOf<UiText?>(null) }
    val current = form
    SubScreen(stringResource(R.string.settings_providers_section_search), onBack, busy = writes.busy || settings.loading, error = problem ?: writes.error ?: settings.error, onRetry = settings::reload) {
        val loaded = settings.value
        if (current != null && loaded != null) {
            val busy = writes.busy
            val statuses = searchStatuses(loaded)
            val now = System.currentTimeMillis()
            val rows = current.order
            val ready = firstReady(current, statuses, now)
            SettingsGroup(title = stringResource(R.string.settings_search_order)) {
                SettingsRow(stringResource(R.string.settings_search_order_hint))
            }
            rows.forEachIndexed { index, id ->
                val keyId = if (id == ExaApiRow) "exa" else id
                val status = statuses.firstOrNull { it.id == id }
                val configured = when {
                    id == "exa" -> true
                    id == ExaApiRow -> status?.configured == true || current.keys[keyId].orEmpty().isNotBlank()
                    else -> status?.configured ?: false
                }
                val enabled = id in current.providers
                val providerTitle = searchName(id).asString()
                SettingsGroup {
                    SettingsSwitchRow(
                        providerTitle, enabled, { on -> form = current.toggled(id, on); notice = null },
                        icon = ReiIcons.Globe, enabled = !busy,
                        summary = listOfNotNull(
                            searchState(configured, status, now).asString(),
                            if (enabled && id == ready) stringResource(R.string.settings_search_first_available) else null,
                        ).joinToString(" · "),
                    )
                    SettingsRow(
                        stringResource(R.string.settings_search_position, index + 1, rows.size),
                        trailing = {
                            Row {
                                ReiIconButton(
                                    ReiIcons.Up,
                                    stringResource(R.string.settings_search_move_up, providerTitle),
                                    { form = current.copy(order = moveSearch(current.order, id, -1)); notice = UiText.Resource(R.string.settings_search_moved, searchName(id)) },
                                    enabled = !busy && index > 0,
                                )
                                ReiIconButton(
                                    ReiIcons.Down,
                                    stringResource(R.string.settings_search_move_down, providerTitle),
                                    { form = current.copy(order = moveSearch(current.order, id, 1)); notice = UiText.Resource(R.string.settings_search_moved, searchName(id)) },
                                    enabled = !busy && index < rows.lastIndex,
                                )
                                if (id != "exa") ReiIconButton(ReiIcons.Settings, stringResource(R.string.settings_search_configure, providerTitle), { open = if (open == id) null else id })
                            }
                        },
                    )
                    if (open == id) {
                        FormGroup(note = stringResource(R.string.settings_search_config_note)) {
                            if (id == "codex-subscription") {
                                ReiTextField(
                                    current.codexModel, { form = current.copy(codexModel = it.take(100)) }, stringResource(R.string.settings_search_model_label), enabled = !busy,
                                    supportingText = stringResource(R.string.settings_search_codex_hint),
                                )
                            }
                            if (id == "searxng") {
                                ReiTextField(current.searxngUrl, { form = current.copy(searxngUrl = it) }, stringResource(R.string.settings_search_searxng_url), placeholder = stringResource(R.string.settings_search_searxng_placeholder), enabled = !busy)
                            }
                            if (id != "codex-subscription" && id != "exa") {
                                SecretField(
                                    current.keys[keyId].orEmpty(), { form = current.copy(keys = current.keys + (keyId to it)); notice = null },
                                    when (id) {
                                        "searxng" -> stringResource(R.string.settings_search_searxng_auth)
                                        ExaApiRow -> stringResource(R.string.settings_search_exa_api_key)
                                        else -> stringResource(R.string.settings_search_api_key_label, providerTitle)
                                    },
                                    placeholder = stringResource(R.string.settings_search_api_key_placeholder), enabled = !busy,
                                )
                            }
                        }
                    }
                }
            }
            FormGroup(note = notice?.asString() ?: stringResource(R.string.settings_search_save_hint)) {
                FormButton(stringResource(R.string.settings_providers_save_changes), enabled = !busy, onClick = {
                    when (val save = searchSave(current)) {
                        is SearchSave.Invalid -> problem = save.message
                        is SearchSave.Ready -> {
                            problem = null
                            writes.run({ notice = UiText.Resource(R.string.settings_embed_saved); settings.reload() }) { api.request("POST", listOf("api", "providers", "search-settings"), save.body) }
                        }
                    }
                })
            }
        }
    }
}
