package dev.rei.android.data

import android.app.Activity
import android.content.Intent
import dev.rei.android.MessageTarget
import dev.rei.android.NotificationTarget
import dev.rei.android.authenticateWithPasskey
import dev.rei.android.di.AppDispatchers
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Auth, connection, and global-stream status exposed to the app shell and connect screen (never carries [ReiApi]). */
data class SessionState(
    val serverUrl: String = "",
    val auth: AuthState? = null,
    val signedIn: Boolean = false,
    val working: Boolean = false,
    val error: String? = null,
    val errorCode: String? = null,
    val upgradeRequired: Boolean = false,
    val restoring: Boolean = true,
)

/**
 * Single source of truth for the active server connection, sign-in credentials, foreground-aware global SSE stream,
 * notification deep-link targets, and centralized 401/426 failure handling.
 */
class SessionRepository(
    private val scope: CoroutineScope,
    private val credentials: CredentialsGateway,
    private val dispatchers: AppDispatchers = AppDispatchers(),
    private val apiFactory: (serverUrl: String, token: String?) -> ReiApi = { url, token -> ReiApi(url, token) },
    private val passkeyAuthenticator: suspend (Activity, ReiApi, String) -> String? = ::authenticateWithPasskey,
    private val onSyncPush: () -> Unit = {},
    private val onSignedOut: () -> Unit = {},
    private val onOutdated: () -> Unit = {},
    private val openNotificationIntent: suspend (Intent) -> NotificationTarget? = { null },
    autoRestore: Boolean = true,
) {
    private val mutableState = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = mutableState.asStateFlow()

    private val apiState = MutableStateFlow<ReiApi?>(null)
    val api: StateFlow<ReiApi?> = apiState.asStateFlow()
    val currentApi: ReiApi? get() = apiState.value

    private val foregroundState = MutableStateFlow(false)
    val inForeground: StateFlow<Boolean> = foregroundState.asStateFlow()

    private val changeNotices = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val changes: SharedFlow<String> = changeNotices.asSharedFlow()

    private val globalEventsFlow = MutableSharedFlow<GlobalEvent>(extraBufferCapacity = 32)
    val globalEvents: SharedFlow<GlobalEvent> = globalEventsFlow.asSharedFlow()

    private val pendingNotificationState = MutableStateFlow<NotificationTarget?>(null)
    val pendingNotification: StateFlow<NotificationTarget?> = pendingNotificationState.asStateFlow()

    private val messageTargetState = MutableStateFlow<MessageTarget?>(null)
    val messageTarget: StateFlow<MessageTarget?> = messageTargetState.asStateFlow()

    private var globalJob: Job? = null
    private var authOperation: Job? = null
    private val current get() = mutableState.value

    init {
        if (autoRestore) restore()
    }

    fun restore() {
        runAuthOperation {
            try {
                val saved = withContext(dispatchers.io) { credentials.load() } ?: return@runAuthOperation
                mutableState.update { it.copy(serverUrl = saved.serverUrl) }
                probe(apiFactory(saved.serverUrl, saved.token))
            } finally {
                mutableState.update { it.copy(restoring = false) }
            }
        }
    }

    fun connect(serverUrl: String) = runAuthOperation {
        val candidate = apiFactory(serverUrl, null)
        val saved = withContext(dispatchers.io) { credentials.load() }
        if (saved != null && saved.serverUrl != candidate.serverUrl) {
            withContext(dispatchers.io) { credentials.clear() }
        }
        val token = saved?.takeIf { it.serverUrl == candidate.serverUrl }?.token
        mutableState.update { it.copy(serverUrl = candidate.serverUrl, auth = null) }
        probe(if (token == null) candidate else apiFactory(candidate.serverUrl, token))
    }

    private suspend fun probe(candidate: ReiApi) {
        candidate.health()
        val auth = candidate.authState()
        if (auth.signedIn) {
            enter(candidate)
        } else {
            withContext(dispatchers.io) { credentials.save(candidate.serverUrl, null) }
            mutableState.update { it.copy(auth = auth, serverUrl = candidate.serverUrl, signedIn = false) }
        }
    }

    fun signIn(password: String, code: String, deviceLabel: String) = runAuthOperation {
        val auth = current.auth ?: return@runAuthOperation
        val candidate = apiFactory(current.serverUrl, null)
        val token = if (auth.setupRequired) {
            candidate.setup(code.trim(), password, deviceLabel.trim())
        } else {
            candidate.login(password, code.trim().ifEmpty { null }, deviceLabel.trim())
        }
        saveSignedInDevice(candidate, token)
    }

    fun signInWithPasskey(activity: Activity, deviceLabel: String) = runAuthOperation {
        val candidate = apiFactory(current.serverUrl, null)
        if (current.auth?.passkeys != true) return@runAuthOperation
        val token = passkeyAuthenticator(activity, candidate, deviceLabel.trim()) ?: return@runAuthOperation
        saveSignedInDevice(candidate, token)
    }

    private suspend fun saveSignedInDevice(candidate: ReiApi, token: String) {
        withContext(dispatchers.io) { credentials.save(candidate.serverUrl, token) }
        enter(apiFactory(candidate.serverUrl, token))
    }

    private fun enter(activeApi: ReiApi) {
        apiState.value = activeApi
        mutableState.update {
            SessionState(
                serverUrl = activeApi.serverUrl,
                signedIn = true,
                working = it.working,
                restoring = false,
            )
        }
        if (foregroundState.value) {
            observeGlobal(activeApi)
        }
        onSyncPush()
    }

    fun signOut() = runAuthOperation {
        val active = currentApi ?: return@runAuthOperation
        val revoked = revoke(active)
        reset(
            active.serverUrl,
            if (!revoked) "Signed out here. Revoke this device in Rei when the server is reachable." else null,
        )
        if (revoked) probe(apiFactory(active.serverUrl, null))
    }

    fun disconnect() = runAuthOperation {
        val active = currentApi
        val revoked = active == null || revoke(active)
        reset(error = if (!revoked) "Disconnected here. Revoke this device in Rei when the server is reachable." else null)
    }

    private suspend fun revoke(active: ReiApi): Boolean = try {
        active.logout()
        true
    } catch (failure: IOException) {
        failure is ReiApiException && failure.status == 401
    }

    private suspend fun reset(serverUrl: String = "", error: String? = null, upgrade: Boolean = false) {
        val caller = currentCoroutineContext()[Job]
        listOf(globalJob).filter { it != caller }.forEach { it?.cancel() }
        globalJob = null
        pendingNotificationState.value = null
        messageTargetState.value = null
        apiState.value = null
        withContext(dispatchers.io) { credentials.clear() }
        onSignedOut()
        mutableState.value = SessionState(
            serverUrl = serverUrl,
            signedIn = false,
            error = error,
            upgradeRequired = upgrade,
            restoring = false,
        )
    }

    fun foreground(visible: Boolean) {
        foregroundState.value = visible
        val active = currentApi ?: return
        if (visible) {
            onSyncPush()
            if (globalJob?.isActive != true) observeGlobal(active)
        } else {
            // Pause the background SSE drain when the app leaves the screen; onForeground resumes it cleanly.
            globalJob?.cancel()
            globalJob = null
        }
    }

    fun handleNotificationIntent(intent: Intent) {
        scope.launch {
            val target = openNotificationIntent(intent)
            if (target != null && target.sessionId.isNotBlank()) {
                pendingNotificationState.value = target
            }
        }
    }

    fun consumePendingNotification(target: NotificationTarget) {
        pendingNotificationState.update { if (it == target) null else it }
    }

    fun setMessageTarget(target: MessageTarget?) {
        messageTargetState.value = target
    }

    fun consumeMessageTarget(target: MessageTarget) {
        messageTargetState.update { if (it == target) null else it }
    }

    /** Executes an approval decision in the application scope so rotation does not cancel the HTTP mutation. */
    suspend fun decideApproval(
        approvalId: String,
        approve: Boolean,
        length: String = "once",
        hours: Int? = null,
    ): ReiApproval {
        val active = currentApi ?: throw IOException("Not connected")
        return scope.async {
            try {
                active.decideApproval(approvalId, approve, length, hours)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                if (failure is ReiApiException && failure.status in setOf(401, 426)) {
                    reportFailure(failure)
                }
                throw failure
            }
        }.await()
    }

    fun reportFailure(failure: Exception) {
        scope.launch { handleFailure(failure) }
    }

    private fun observeGlobal(activeApi: ReiApi) {
        globalJob?.cancel()
        globalJob = scope.launch {
            try {
                activeApi.globalStream().collect { event ->
                    if (event is GlobalEvent.Changed) {
                        changeNotices.tryEmit(event.type)
                    } else if (event is GlobalEvent.Snapshot) {
                        changeNotices.tryEmit("snapshot")
                    }
                    globalEventsFlow.emit(event)
                }
            } catch (failure: Exception) {
                handleFailure(failure)
            }
        }
    }

    private fun runAuthOperation(block: suspend () -> Unit) {
        authOperation?.cancel()
        authOperation = scope.launch {
            mutableState.update { it.copy(working = true, error = null, errorCode = null, upgradeRequired = false) }
            try {
                block()
            } catch (failure: Exception) {
                handleFailure(failure)
            } finally {
                mutableState.update { it.copy(working = false) }
            }
        }
    }

    private suspend fun handleFailure(failure: Exception) {
        if (failure is CancellationException) throw failure
        val message = when (failure) {
            is ReiApiException -> failure.message.orEmpty().ifBlank { "Rei could not complete the request." }
            is IllegalArgumentException, is IllegalStateException -> failure.message ?: "Check the server address."
            is IOException -> "Couldn’t reach Rei. Check your connection and try again."
            else -> "Rei returned a response this app couldn’t read."
        }
        val status = (failure as? ReiApiException)?.status
        if (status == 426) onOutdated()
        if (status == 401 && currentApi != null) {
            reset(current.serverUrl, "This device is signed out. Connect and sign in again.")
        } else if (status == 426 && currentApi != null) {
            reset(current.serverUrl, message, upgrade = true)
        } else {
            mutableState.update {
                it.copy(
                    error = message,
                    errorCode = (failure as? ReiApiException)?.code,
                    upgradeRequired = status == 426,
                )
            }
        }
    }
}
