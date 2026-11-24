package dev.rei.android.feature.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
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
import dev.rei.android.data.chatAgent
import dev.rei.android.data.obj
import dev.rei.android.ui.components.AgentAvatar
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private val AgentBotChoices = mapOf(
    "bot:sprout" to "Bonsai",
    "bot:round" to "River Stone",
    "bot:antenna" to "Lantern",
    "bot:cat" to "Lucky Cat",
    "bot:ghost" to "Paper Crane",
    "bot:astro" to "Moon Rabbit",
)

/** Creates an agent with the chosen name and look. The caller opens its Home chat. */
@Composable
fun NewAgentSheet(api: ReiApi, onDismiss: () -> Unit, onCreated: (ChatAgent) -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var bot by remember { mutableStateOf<String?>(null) }
    var emoji by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val request = createAgentBody(name, bot ?: emoji)
    fun create() {
        val sent = request ?: return
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val created = api.request("POST", listOf("api", "agents"), sent).obj("agent").chatAgent()
                onCreated(created)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: "Couldn’t create the agent. Try again."
                busy = false
            }
        }
    }
    ReiSheet(onDismiss = { if (!busy) onDismiss() }, title = "New agent") {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ReiTextField(name, { name = it.take(AgentNameMax) }, "Name", enabled = !busy)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Pick a bot", style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgentBotChoices.forEach { (value, label) ->
                        FilterChip(
                            selected = bot == value,
                            onClick = {
                                bot = value
                                emoji = ""
                            },
                            label = { Text(label) },
                            enabled = !busy,
                            leadingIcon = { AgentAvatar(value, size = 24.dp) },
                        )
                    }
                }
            }
            ReiTextField(
                emoji,
                {
                    emoji = it.take(8)
                    bot = null
                },
                "Or an emoji or a few letters",
                placeholder = "🙂",
                enabled = !busy,
            )
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                ::create,
                Modifier.fillMaxWidth().heightIn(min = 48.dp),
                enabled = !busy && request != null,
                shape = ReiShapes.Pill,
            ) {
                Text(if (busy) "Creating…" else "Create")
            }
            OutlinedButton(onDismiss, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !busy, shape = ReiShapes.Pill) {
                Text("Cancel")
            }
        }
    }
}
