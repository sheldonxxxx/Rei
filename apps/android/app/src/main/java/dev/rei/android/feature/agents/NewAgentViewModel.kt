package dev.rei.android.feature.agents

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.chatAgent
import dev.rei.android.data.obj
import dev.rei.android.di.AppContainer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class NewAgentUiState(
    val name: String = "",
    val bot: String? = null,
    val emoji: String = "",
    val busy: Boolean = false,
    val error: String? = null,
)

private const val KeyName = "new_agent_name"
private const val KeyBot = "new_agent_bot"
private const val KeyEmoji = "new_agent_emoji"

/** Runs manual agent creation in [viewModelScope] and retains form inputs across configuration changes. */
class NewAgentViewModel(
    private val session: SessionRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val mutable = MutableStateFlow(
        NewAgentUiState(
            name = savedStateHandle.get<String>(KeyName).orEmpty(),
            bot = savedStateHandle.get<String>(KeyBot),
            emoji = savedStateHandle.get<String>(KeyEmoji).orEmpty(),
        ),
    )
    val state: StateFlow<NewAgentUiState> = mutable.asStateFlow()

    private val createdFlow = MutableSharedFlow<ChatAgent>(extraBufferCapacity = 2)
    val created: SharedFlow<ChatAgent> = createdFlow.asSharedFlow()

    fun setName(value: String) {
        val trimmed = value.take(AgentNameMax)
        savedStateHandle[KeyName] = trimmed
        mutable.update { it.copy(name = trimmed, error = null) }
    }

    fun selectBot(value: String) {
        savedStateHandle[KeyBot] = value
        savedStateHandle[KeyEmoji] = ""
        mutable.update { it.copy(bot = value, emoji = "", error = null) }
    }

    fun setEmoji(value: String) {
        val trimmed = value.take(8)
        savedStateHandle[KeyBot] = null
        savedStateHandle[KeyEmoji] = trimmed
        mutable.update { it.copy(bot = null, emoji = trimmed, error = null) }
    }

    fun create() {
        val current = mutable.value
        val sent = createAgentBody(current.name, current.bot ?: current.emoji) ?: return
        val api = session.currentApi ?: return
        if (current.busy) return
        mutable.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val created = api.request("POST", listOf("api", "agents"), sent).obj("agent").chatAgent()
                reset()
                createdFlow.tryEmit(created)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                val message = failure.message?.takeIf { it.isNotBlank() } ?: "Couldn’t create the agent. Try again."
                mutable.update { it.copy(busy = false, error = message) }
            }
        }
    }

    fun reset() {
        savedStateHandle[KeyName] = ""
        savedStateHandle[KeyBot] = null
        savedStateHandle[KeyEmoji] = ""
        mutable.value = NewAgentUiState()
    }

    companion object {
        fun factory(container: AppContainer): ViewModelProvider.Factory = viewModelFactory {
            initializer {
                NewAgentViewModel(
                    session = container.sessionRepository,
                    savedStateHandle = createSavedStateHandle(),
                )
            }
        }
    }
}
