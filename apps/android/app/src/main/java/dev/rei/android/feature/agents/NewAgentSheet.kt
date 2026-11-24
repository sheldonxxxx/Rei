package dev.rei.android.feature.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.chatAgent
import dev.rei.android.data.obj
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Makes an agent from one sentence: a model writes its name, look and instructions, which can take a few seconds, so the
 * sheet shows progress and keeps the text until it is done. [onCreated] receives the new agent; the caller opens its chat.
 */
@Composable
fun NewAgentSheet(api: ReiApi, onDismiss: () -> Unit, onCreated: (ChatAgent) -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val description = agentDescription(text)
    fun create() {
        val sent = description ?: return
        busy = true
        error = null
        scope.launch {
            try {
                val created = api.request("POST", listOf("api", "agents"), createAgentBody(sent)).obj("agent").chatAgent()
                onCreated(created)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                error = (failure as? ReiApiException)?.let { agentErrorMessage(it.code, it.message.orEmpty()) }
                    ?: failure.message ?: "Couldn’t create the agent. Try again."
                busy = false
            }
        }
    }
    ReiSheet(onDismiss = onDismiss, title = "New agent") {
        Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                if (busy) "Setting up your agent…" else "One sentence is enough.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ReiTextField(
                text, { text = it.take(AgentDescriptionMax) }, "What kind of agent do you want?",
                placeholder = "A social media manager", singleLine = false, minLines = 3, enabled = !busy, error = error,
            )
            Button(::create, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !busy && description != null, shape = ReiShapes.Pill) {
                Text(if (busy) "Creating…" else "Create")
            }
            OutlinedButton(onDismiss, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !busy, shape = ReiShapes.Pill) { Text("Cancel") }
        }
    }
}
