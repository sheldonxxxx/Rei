package dev.rei.android.update

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.edit
import androidx.core.net.toUri
import dev.rei.android.BuildConfig
import dev.rei.android.R
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the in-app update flow stands. The UI in `UpdatePrompt` and the Settings row read it. */
sealed interface UpdateState {
    data object Idle : UpdateState

    data object Checking : UpdateState

    data object UpToDate : UpdateState

    /** A newer build is published; the person has not decided yet. */
    data class Available(val feed: UpdateFeed) : UpdateState

    /** Android has not allowed Rei to install apps yet; the person is asked to turn that on first. */
    data class NeedsPermission(val feed: UpdateFeed) : UpdateState

    /** The system settings page is open; the flow continues when the app returns to the foreground. */
    data class AwaitingPermission(val feed: UpdateFeed) : UpdateState

    data class Downloading(val feed: UpdateFeed, val received: Long, val total: Long) : UpdateState {
        /** 0..100, or null while the size is unknown. */
        val percent: Int? get() = if (total > 0) (received * 100 / total).toInt().coerceIn(0, 100) else null
    }

    /** The APK is with the installer; [confirming] is true while Android's own confirmation screen is up. */
    data class Installing(val feed: UpdateFeed, val confirming: Boolean = false) : UpdateState

    data class Failed(val message: String, val feed: UpdateFeed) : UpdateState
}

/**
 * The one place that runs the self-update: it checks the feed, downloads and verifies the APK, asks for the install
 * permission, installs, and exposes [state]. It is process-wide because the install result arrives at a receiver.
 * Checks are off when `BuildConfig.UPDATE_FEED_URL` is empty.
 */
class UpdateManager private constructor(
    context: Context,
    private val checker: UpdateChecker,
) {
    private val app = context.applicationContext as Application
    private val preferences = app.getSharedPreferences("rei_update", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutableState = MutableStateFlow<UpdateState>(UpdateState.Idle)
    private val mutableMessages = MutableSharedFlow<String>(extraBufferCapacity = 4)
    private var job: Job? = null
    private val confirmations = ConfirmationGate<Intent> { confirm -> app.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    private val apkDirectory get() = File(app.cacheDir, "updates")

    val state: StateFlow<UpdateState> = mutableState.asStateFlow()

    /** One-line results of a check the person asked for ("You’re on the latest version."), for the app's snackbar. */
    val messages: SharedFlow<String> = mutableMessages.asSharedFlow()

    /** False when no feed URL is configured. */
    val enabled: Boolean get() = checker.enabled

    init {
        // Nothing is in flight in a fresh process, and the installer keeps its own copy of an APK it has been given.
        scope.launch(Dispatchers.IO) { apkDirectory.deleteRecursively() }
    }

    /** Called when the app opens: checks the feed unless one was checked in the last day. */
    fun checkAtLaunch(now: Long = System.currentTimeMillis()) {
        if (!enabled || !updateCheckDue(preferences.getLong(LastCheck, 0), now)) return
        check(manual = false)
    }

    /** The Settings row. A manual check says what it found, including "up to date" and failures. */
    fun checkNow() = check(manual = true)

    /** The server refused this app with 426: look for an update now, whatever the daily limit says. */
    fun onClientOutdated() = check(manual = false)

    private fun check(manual: Boolean) {
        if (!enabled) {
            if (manual) mutableMessages.tryEmit(app.getString(R.string.update_msg_off))
            return
        }
        if (job?.isActive == true) return
        when (mutableState.value) {
            is UpdateState.Downloading, is UpdateState.Installing, is UpdateState.AwaitingPermission -> return
            else -> Unit
        }
        preferences.edit { putLong(LastCheck, System.currentTimeMillis()) }
        job = scope.launch {
            mutableState.value = UpdateState.Checking
            try {
                when (val result = checker.check()) {
                    UpdateCheck.Disabled -> mutableState.value = UpdateState.Idle
                    UpdateCheck.UpToDate -> {
                        mutableState.value = UpdateState.UpToDate
                        if (manual) mutableMessages.tryEmit(app.getString(R.string.update_msg_latest))
                    }
                    is UpdateCheck.Available -> mutableState.value = UpdateState.Available(result.feed)
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                mutableState.value = UpdateState.Idle
                val text = (failure as? UpdateException)?.uiText?.asString(app)
                    ?: failure.message
                    ?: app.getString(R.string.update_err_check)
                if (manual) mutableMessages.tryEmit(text)
            }
        }
    }

    /** The person agreed to update: ask for the install permission if it is missing, otherwise download. */
    fun confirm() {
        val feed = when (val current = mutableState.value) {
            is UpdateState.Available -> current.feed
            is UpdateState.Failed -> current.feed
            else -> return
        }
        if (canInstall()) download(feed) else mutableState.value = UpdateState.NeedsPermission(feed)
    }

    /** Opens Android's "install unknown apps" page for Rei. The flow continues in [onForeground]. */
    fun openInstallSettings() {
        val feed = (mutableState.value as? UpdateState.NeedsPermission)?.feed ?: return
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${app.packageName}".toUri())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        mutableState.value = UpdateState.AwaitingPermission(feed)
        try {
            app.startActivity(intent)
        } catch (_: Exception) {
            mutableState.value = UpdateState.Failed(app.getString(R.string.update_err_open_settings), feed)
        }
    }

    /** The app came back to the foreground, maybe from the permission page or with an installer confirmation waiting. */
    fun onForeground() {
        when (confirmations.onForeground()) {
            ConfirmationGate.Outcome.Launched -> onInstallWaitingForUser()
            ConfirmationGate.Outcome.Blocked -> onInstallResult(PackageInstaller.STATUS_FAILURE_BLOCKED, null)
            else -> Unit
        }
        val feed = (mutableState.value as? UpdateState.AwaitingPermission)?.feed ?: return
        if (canInstall()) download(feed)
        else mutableState.value = UpdateState.Failed(app.getString(R.string.update_err_not_allowed), feed)
    }

    fun onBackground() = confirmations.onBackground()

    /**
     * Gives up on an install that is with the system installer, including one whose confirmation screen was dismissed
     * or never shown. The person lands on "Try again" instead of being stuck behind a banner.
     */
    fun cancelInstall() {
        val feed = (mutableState.value as? UpdateState.Installing)?.feed ?: return
        confirmations.clear()
        val installer = app.packageManager.packageInstaller
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        scope.launch(Dispatchers.IO) { apkDirectory.deleteRecursively() }
        mutableState.value = UpdateState.Failed(installFailureMessage(PackageInstaller.STATUS_FAILURE_ABORTED, null).asString(app), feed)
    }

    /** "Later" or "Close": leaves the flow without changing anything. */
    fun dismiss() {
        when (mutableState.value) {
            is UpdateState.Available, is UpdateState.NeedsPermission, is UpdateState.Failed -> {
                mutableState.value = UpdateState.Idle
                scope.launch(Dispatchers.IO) { apkDirectory.deleteRecursively() }
            }
            else -> Unit
        }
    }

    private fun canInstall() = app.packageManager.canRequestPackageInstalls()

    private fun download(feed: UpdateFeed) {
        job?.cancel()
        job = scope.launch {
            val file = File(apkDirectory, "rei-${feed.versionCode}.apk")
            try {
                mutableState.value = UpdateState.Downloading(feed, 0, -1)
                checker.download(feed, file) { received, total ->
                    mutableState.value = UpdateState.Downloading(feed, received, total)
                }
                mutableState.value = UpdateState.Installing(feed)
                withContext(Dispatchers.IO) {
                    UpdateInstaller.install(app, file)
                    // The session holds its own copy once committed, so the cached download is no longer needed.
                    file.delete()
                }
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                file.delete()
                val text = (failure as? UpdateException)?.uiText?.asString(app)
                    ?: failure.message
                    ?: app.getString(R.string.update_err_failed)
                mutableState.value = UpdateState.Failed(text, feed)
            }
        }
    }

    /** Android needs the person to confirm: show its screen now if Rei is visible, otherwise when Rei comes back. */
    internal fun onInstallNeedsConfirmation(confirm: Intent) {
        when (confirmations.offer(confirm)) {
            ConfirmationGate.Outcome.Launched -> onInstallWaitingForUser()
            ConfirmationGate.Outcome.Blocked -> onInstallResult(PackageInstaller.STATUS_FAILURE_BLOCKED, null)
            ConfirmationGate.Outcome.Deferred -> Unit
        }
    }

    private fun onInstallWaitingForUser() {
        val current = mutableState.value
        if (current is UpdateState.Installing) mutableState.value = current.copy(confirming = true)
    }

    internal fun onInstallResult(status: Int, detail: String?) {
        confirmations.clear()
        val feed = when (val current = mutableState.value) {
            is UpdateState.Installing -> current.feed
            is UpdateState.Failed -> current.feed
            else -> null
        }
        scope.launch(Dispatchers.IO) { apkDirectory.deleteRecursively() }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            // Normally the process is replaced before this runs.
            mutableState.value = UpdateState.Idle
        } else if (feed != null) {
            mutableState.value = UpdateState.Failed(installFailureMessage(status, detail).asString(app), feed)
        } else {
            mutableState.value = UpdateState.Idle
        }
    }

    companion object {
        private const val LastCheck = "lastCheck"

        @Volatile
        private var instance: UpdateManager? = null

        fun get(context: Context): UpdateManager = instance ?: synchronized(this) {
            instance ?: UpdateManager(
                context,
                UpdateChecker(BuildConfig.UPDATE_FEED_URL, BuildConfig.VERSION_CODE, Build.VERSION.SDK_INT),
            ).also { instance = it }
        }
    }
}
