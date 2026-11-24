package dev.rei.android

import android.app.Activity
import android.app.Application
import android.content.Intent
import androidx.compose.runtime.Immutable
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.rei.android.data.AuthState
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.ChatCatalogState
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.Session
import dev.rei.android.data.SessionState
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

@Immutable
data class ReiUiState(
    val serverUrl: String = "",
    val auth: AuthState? = null,
    val signedIn: Boolean = false,
    val working: Boolean = false,
    val error: String? = null,
    /** The server's error code for [error] (for example `bad_totp`), so a screen can show it under the right field. */
    val errorCode: String? = null,
    val upgradeRequired: Boolean = false,
    val sessions: List<Session> = emptyList(),
    val agents: List<ChatAgent> = emptyList(),
    val selectedAgentId: String? = null,
    val nextCursor: String? = null,
    val historyLoaded: Boolean = false,
    /** The chat open in the chat destination. Its conversation lives in `ChatViewModel`. */
    val sessionId: String? = null,
    /** Approvals waiting in every session, oldest first. The shell reads them for its badge and attention dots. */
    val waitingApprovals: List<ReiApproval> = emptyList(),
    /** Sessions with a browser takeover waiting for the user. */
    val takeoverSessionIds: Set<String> = emptySet(),
    /** True until the saved sign-in has been checked, so the splash screen can wait and the connect screen never flashes. */
    val restoring: Boolean = false,
)

/** A message to scroll to (and briefly highlight) once its chat is open. */
data class MessageTarget(val sessionId: String, val messageId: String)

/** SharedPreferences key prefix (file `chat_state`) for a chat's draft: `key`, `key:attachments`, `key:request`. */
internal fun chatDraftKey(serverUrl: String, sessionId: String) = "draft:$serverUrl:$sessionId"

/**
 * Activity-level coordinator between [MainActivity], the connect screen, and the application repositories.
 * Feature ViewModels inject repositories from [ReiApplication.container] directly rather than depending on this ViewModel.
 */
class ReiViewModel(application: Application) : AndroidViewModel(application) {
    val container = (application as ReiApplication).container
    private val session = container.sessionRepository
    private val catalog = container.chatCatalogRepository

    val state: StateFlow<ReiUiState> = combine(session.state, catalog.state) { auth, cat ->
        auth.toUiState(cat)
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(5_000),
        session.state.value.toUiState(catalog.state.value),
    )

    val api: StateFlow<ReiApi?> = session.api
    val pendingNotification: StateFlow<NotificationTarget?> = session.pendingNotification

    fun connect(serverUrl: String) = session.connect(serverUrl)
    fun signIn(password: String, code: String, deviceLabel: String) = session.signIn(password, code, deviceLabel)
    fun signInWithPasskey(activity: Activity, deviceLabel: String) = session.signInWithPasskey(activity, deviceLabel)
    fun signOut() = session.signOut()
    fun disconnect() = session.disconnect()
    fun foreground(visible: Boolean) = session.foreground(visible)
    fun handleNotificationIntent(intent: Intent) = session.handleNotificationIntent(intent)

    fun openNotification(target: NotificationTarget) {
        catalog.openNotification(target)
        session.consumePendingNotification(target)
    }
}

private fun SessionState.toUiState(cat: ChatCatalogState) = ReiUiState(
    serverUrl = serverUrl,
    auth = auth,
    signedIn = signedIn,
    working = working,
    error = error,
    errorCode = errorCode,
    upgradeRequired = upgradeRequired,
    sessions = cat.sessions,
    agents = cat.agents,
    selectedAgentId = cat.selectedAgentId,
    nextCursor = cat.nextCursor,
    historyLoaded = cat.historyLoaded,
    sessionId = cat.sessionId,
    waitingApprovals = cat.waitingApprovals,
    takeoverSessionIds = cat.takeoverSessionIds,
    restoring = restoring,
)
