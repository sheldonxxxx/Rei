package dev.rei.android.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Receives the [PackageInstaller] status for an update. When Android needs the person to confirm, it hands over an intent
 * that this receiver launches. The receiver is not exported: only the PendingIntent given to the session reaches it.
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val manager = UpdateManager.get(context)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirm == null) {
                    manager.onInstallResult(PackageInstaller.STATUS_FAILURE, null)
                } else {
                    try {
                        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        manager.onInstallWaitingForUser()
                    } catch (_: Exception) {
                        manager.onInstallResult(PackageInstaller.STATUS_FAILURE_BLOCKED, null)
                    }
                }
            }
            else -> manager.onInstallResult(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }
}
