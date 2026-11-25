package dev.rei.android.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import dev.rei.android.R
import dev.rei.android.ui.UiText
import java.io.File
import java.io.IOException

/** Installs a verified APK through a [PackageInstaller] session. The outcome arrives at [UpdateInstallReceiver]. */
internal object UpdateInstaller {
    const val ACTION = "dev.rei.android.UPDATE_INSTALL_STATUS"

    fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        // A session left over from an earlier attempt would hold on to its copy of the APK.
        installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            // Only takes effect on a first install; harmless when updating, and keeps Rei the owner if it is ever installed fresh.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) setRequestUpdateOwnership(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val id = installer.createSession(params)
        val session = installer.openSession(id)
        try {
            apk.inputStream().use { input ->
                session.openWrite("rei-update.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            // The system fills in the status extras, so the PendingIntent must be mutable; the intent names our own receiver.
            val intent = Intent(context, UpdateInstallReceiver::class.java).setAction(ACTION).setPackage(context.packageName)
            val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(pending.intentSender)
        } catch (failure: Exception) {
            runCatching { session.abandon() }
            throw if (failure is IOException) failure else IOException(failure.message, failure)
        } finally {
            session.close()
        }
    }
}

/** A plain-language reason for a [PackageInstaller] failure status; [detail] is the system's own message, if any. */
internal fun installFailureMessage(status: Int, detail: String?): UiText = when (status) {
    PackageInstaller.STATUS_FAILURE_ABORTED -> UiText.Resource(R.string.update_install_cancelled)
    PackageInstaller.STATUS_FAILURE_BLOCKED -> UiText.Resource(R.string.update_install_blocked)
    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
        UiText.Resource(R.string.update_install_conflict)
    PackageInstaller.STATUS_FAILURE_INVALID -> UiText.Resource(R.string.update_install_invalid)
    PackageInstaller.STATUS_FAILURE_STORAGE -> UiText.Resource(R.string.update_install_storage)
    else -> detail?.takeIf { it.isNotBlank() }?.let { UiText.Resource(R.string.update_install_failed_detail, it) }
        ?: UiText.Resource(R.string.update_install_failed)
}
