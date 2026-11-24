package dev.rei.android.feature.settings

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.optionalString
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons

/**
 * Embeddings: the connection Memory search uses to find related notes. A connection is saved only after it has passed
 * Test connection with exactly the values on screen; any edit clears that result. The key is write-only.
 */
@Composable
internal fun EmbeddingScreen(api: ReiApi, onBack: () -> Unit) {
    val writes = rememberWrites()
    val setup = rememberResource(api) { api.request("GET", listOf("api", "embedding", "setup")) }
    var form by remember(setup.value) { mutableStateOf(setup.value?.let(::embeddingForm)) }
    var verifiedDims by remember { mutableStateOf<Long?>(null) }
    var verified by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<UiText?>(null) }
    val current = form
    fun edit(next: EmbeddingForm) { form = next; verified = false; verifiedDims = null; saved = false; problem = null }
    SubScreen(stringResource(R.string.settings_providers_section_embeddings), onBack, busy = writes.busy || setup.loading, error = problem ?: writes.error ?: setup.error, onRetry = setup::reload) {
        if (current != null) {
            val busy = writes.busy
            SettingsGroup {
                ChoiceRow(
                    stringResource(R.string.settings_embed_provider_label), current.provider,
                    listOf(
                        Choice(EmbedOff, UiText.Resource(R.string.settings_embed_off)),
                        Choice(EmbedOmlx, UiText.Resource(R.string.settings_embed_omlx)),
                        Choice(EmbedOpenAi, UiText.Resource(R.string.settings_embed_openai)),
                    ),
                    icon = ReiIcons.Memory, onSelect = { edit(current.withProvider(it)) }, enabled = !busy,
                )
            }
            if (current.needsTest()) {
                FormGroup(title = stringResource(R.string.settings_embed_connection)) {
                    ReiTextField(current.baseUrl, { edit(current.copy(baseUrl = it, profile = null)) }, stringResource(R.string.settings_embed_url), placeholder = stringResource(R.string.settings_embed_url_placeholder), enabled = !busy)
                    ReiTextField(current.apiModel, { edit(current.copy(apiModel = it, profile = null)) }, stringResource(R.string.settings_embed_model_id), enabled = !busy)
                    SecretField(
                        current.apiKey, { edit(current.copy(apiKey = it)) }, stringResource(R.string.settings_embed_api_key),
                        placeholder = stringResource(R.string.settings_embed_api_key_placeholder), enabled = !busy,
                    )
                }
                if (current.provider == EmbedOpenAi) {
                    FormGroup(title = stringResource(R.string.settings_embed_advanced), note = stringResource(R.string.settings_embed_advanced_note)) {
                        NumberField(current.contextTokens, { edit(current.copy(contextTokens = it, profile = null)) }, stringResource(R.string.settings_embed_text_limit), enabled = !busy)
                        ReiTextField(current.docTemplate, { edit(current.copy(docTemplate = it, profile = null)) }, stringResource(R.string.settings_embed_doc_template), enabled = !busy)
                        ReiTextField(current.queryTemplate, { edit(current.copy(queryTemplate = it, profile = null)) }, stringResource(R.string.settings_embed_query_template), enabled = !busy)
                    }
                }
            }
            FormGroup {
                if (verified) {
                    val text = verifiedDims?.let { stringResource(R.string.settings_embed_verified_dims, it) } ?: stringResource(R.string.settings_embed_verified)
                    Text(text, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                } else if (current.needsTest()) {
                    Text(stringResource(R.string.settings_embed_test_before_save), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
                if (saved) Text(stringResource(R.string.settings_embed_saved), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                if (current.needsTest()) {
                    FormButton(stringResource(R.string.settings_embed_test), primary = false, enabled = !busy && current.canTest(), onClick = {
                        val body = embeddingBody(current)
                        if (body == null) { problem = rangeMessage(UiText.Resource(R.string.settings_embed_text_limit), 1, 10_000_000); return@FormButton }
                        verified = false; verifiedDims = null; saved = false; problem = null
                        writes.run {
                            val result = api.request("POST", listOf("api", "embedding", "check"), body)
                            verifiedDims = result.optionalString("dims")?.toLongOrNull()
                            verified = true
                        }
                    })
                }
                FormButton(stringResource(R.string.common_save), enabled = !busy && (!current.needsTest() || verified), onClick = {
                    val body = embeddingBody(current)
                    if (body == null) { problem = rangeMessage(UiText.Resource(R.string.settings_embed_text_limit), 1, 10_000_000); return@FormButton }
                    problem = null
                    writes.run({ saved = true; setup.reload() }) { api.request("POST", listOf("api", "embedding", "setup"), body) }
                })
            }
            if (setup.value?.optionalString("provider") == null) {
                SettingsGroup { SettingsRow(stringResource(R.string.settings_embed_keywords_fallback)) }
            }
        }
    }
}
