package dev.rei.android.feature.settings

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import dev.rei.android.data.ReiApi
import dev.rei.android.data.optionalString
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
    var problem by remember { mutableStateOf<String?>(null) }
    val current = form
    fun edit(next: EmbeddingForm) { form = next; verified = false; verifiedDims = null; saved = false; problem = null }
    SubScreen("Embeddings", onBack, busy = writes.busy || setup.loading, error = problem ?: writes.error ?: setup.error, onRetry = setup::reload) {
        if (current != null) {
            val busy = writes.busy
            SettingsGroup {
                ChoiceRow(
                    "Embedding provider", current.provider,
                    listOf(
                        Choice(EmbedOff, "Off · keyword search"),
                        Choice(EmbedOmlx, "oMLX"),
                        Choice(EmbedOpenAi, "OpenAI-compatible API"),
                    ),
                    icon = ReiIcons.Memory, onSelect = { edit(current.withProvider(it)) }, enabled = !busy,
                )
            }
            if (current.needsTest()) {
                FormGroup(title = "Connection") {
                    ReiTextField(current.baseUrl, { edit(current.copy(baseUrl = it, profile = null)) }, "Embedding URL", placeholder = "https://api.example.com", enabled = !busy)
                    ReiTextField(current.apiModel, { edit(current.copy(apiModel = it, profile = null)) }, "Embedding model ID", enabled = !busy)
                    SecretField(
                        current.apiKey, { edit(current.copy(apiKey = it)) }, "Embedding API key (optional)",
                        placeholder = "Leave blank to keep the key for this URL", enabled = !busy,
                    )
                }
                if (current.provider == EmbedOpenAi) {
                    FormGroup(title = "Advanced", note = "Keep the text placeholders. Change templates only if your model requires them. The conservative text limit is 512; raise it if your model takes longer inputs.") {
                        NumberField(current.contextTokens, { edit(current.copy(contextTokens = it, profile = null)) }, "Text limit (tokens)", enabled = !busy)
                        ReiTextField(current.docTemplate, { edit(current.copy(docTemplate = it, profile = null)) }, "Document template", enabled = !busy)
                        ReiTextField(current.queryTemplate, { edit(current.copy(queryTemplate = it, profile = null)) }, "Search template", enabled = !busy)
                    }
                }
            }
            FormGroup {
                if (verified) Text("Connection verified" + (verifiedDims?.let { " · $it dimensions detected" } ?: ""), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                else if (current.needsTest()) Text("Test the connection with these values before saving.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                if (saved) Text("Saved", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                if (current.needsTest()) {
                    FormButton("Test connection", primary = false, enabled = !busy && current.canTest(), onClick = {
                        val body = embeddingBody(current)
                        if (body == null) { problem = rangeMessage("Text limit (tokens)", 1, 10_000_000); return@FormButton }
                        verified = false; verifiedDims = null; saved = false; problem = null
                        writes.run {
                            val result = api.request("POST", listOf("api", "embedding", "check"), body)
                            verifiedDims = result.optionalString("dims")?.toLongOrNull()
                            verified = true
                        }
                    })
                }
                FormButton("Save", enabled = !busy && (!current.needsTest() || verified), onClick = {
                    val body = embeddingBody(current)
                    if (body == null) { problem = rangeMessage("Text limit (tokens)", 1, 10_000_000); return@FormButton }
                    problem = null
                    writes.run({ saved = true; setup.reload() }) { api.request("POST", listOf("api", "embedding", "setup"), body) }
                })
            }
            if (setup.value?.optionalString("provider") == null) {
                SettingsGroup { SettingsRow("Memory search uses keywords until an embedding provider is saved.") }
            }
        }
    }
}
