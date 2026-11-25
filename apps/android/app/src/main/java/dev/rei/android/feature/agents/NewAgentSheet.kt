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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.R
import dev.rei.android.data.ChatAgent
import dev.rei.android.di.AppContainer
import dev.rei.android.ui.components.AgentAvatar
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.theme.ReiShapes

private val AgentBotChoices = listOf(
    "bot:sprout" to R.string.agents_bot_sprout,
    "bot:round" to R.string.agents_bot_round,
    "bot:antenna" to R.string.agents_bot_antenna,
    "bot:cat" to R.string.agents_bot_cat,
    "bot:ghost" to R.string.agents_bot_ghost,
    "bot:astro" to R.string.agents_bot_astro,
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

    ReiSheet(onDismiss = ::dismiss, title = stringResource(R.string.agents_new_title)) {
        Column(
            Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ReiTextField(state.name, vm::setName, stringResource(R.string.agents_name_label), enabled = !state.busy)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.agents_pick_bot), style = MaterialTheme.typography.labelMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AgentBotChoices.forEach { (value, labelRes) ->
                        FilterChip(
                            selected = state.bot == value,
                            onClick = { vm.selectBot(value) },
                            label = { Text(stringResource(labelRes)) },
                            enabled = !state.busy,
                            leadingIcon = { AgentAvatar(value, size = 24.dp) },
                        )
                    }
                }
            }
            ReiTextField(
                state.emoji,
                vm::setEmoji,
                stringResource(R.string.agents_emoji_label),
                placeholder = stringResource(R.string.agents_emoji_placeholder),
                enabled = !state.busy,
            )
            state.error?.let { Text(it.asString(), color = MaterialTheme.colorScheme.error) }
            Button(
                vm::create,
                Modifier.fillMaxWidth().heightIn(min = 48.dp),
                enabled = !state.busy && request != null,
                shape = ReiShapes.Pill,
            ) {
                Text(stringResource(if (state.busy) R.string.agents_creating else R.string.agents_create))
            }
            OutlinedButton(::dismiss, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.busy, shape = ReiShapes.Pill) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}
