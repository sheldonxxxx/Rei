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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.data.ChatAgent
import dev.rei.android.di.AppContainer
import dev.rei.android.ui.components.AgentAvatar
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes

private val AgentBotChoices = mapOf(
    "bot:sprout" to "Bonsai",
    "bot:round" to "River Stone",
    "bot:antenna" to "Lantern",
    "bot:cat" to "Lucky Cat",
    "bot:ghost" to "Paper Crane",
    "bot:astro" to "Moon Rabbit",
)

/** Creates an agent with the chosen name and look in [NewAgentViewModel]. The caller opens its Home chat. */
@Composable
fun NewAgentSheet(container: AppContainer, onDismiss: () -> Unit, onCreated: (ChatAgent) -> Unit) {
    val vm: NewAgentViewModel = viewModel(factory = NewAgentViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val request = createAgentBody(state.name, state.bot ?: state.emoji)

    LaunchedEffect(vm) {
        vm.created.collect { agent ->
            onCreated(agent)
        }
    }

    fun dismiss() {
        if (!state.busy) {
            vm.reset()
            onDismiss()
        }
    }

    ReiSheet(onDismiss = ::dismiss, title = "New agent") {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ReiTextField(state.name, vm::setName, "Name", enabled = !state.busy)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Pick a bot", style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgentBotChoices.forEach { (value, label) ->
                        FilterChip(
                            selected = state.bot == value,
                            onClick = { vm.selectBot(value) },
                            label = { Text(label) },
                            enabled = !state.busy,
                            leadingIcon = { AgentAvatar(value, size = 24.dp) },
                        )
                    }
                }
            }
            ReiTextField(
                state.emoji,
                vm::setEmoji,
                "Or an emoji or a few letters",
                placeholder = "🙂",
                enabled = !state.busy,
            )
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(
                vm::create,
                Modifier.fillMaxWidth().heightIn(min = 48.dp),
                enabled = !state.busy && request != null,
                shape = ReiShapes.Pill,
            ) {
                Text(if (state.busy) "Creating…" else "Create")
            }
            OutlinedButton(::dismiss, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.busy, shape = ReiShapes.Pill) {
                Text("Cancel")
            }
        }
    }
}
