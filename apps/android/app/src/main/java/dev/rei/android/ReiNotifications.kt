package dev.rei.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.edit
import dev.rei.android.data.CredentialStore
import dev.rei.android.data.ReiApi
import dev.rei.android.data.optionalString
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class NotificationTarget(val sessionId: String, val messageId: String?)

/** What a push message shows. The title falls back to the app name; the body can be empty when previews are off. */
internal data class NotificationContent(val id: Int, val title: String, val body: String) {
    companion object {
        /** One notification per session, message and event, so a repeat of the same push replaces rather than stacks. */
        fun from(data: Map<String, String>, fallbackTitle: String = "Rei") = NotificationContent(
            id = (data["sessionId"].orEmpty() + (data["messageId"] ?: "") + data["event"]).hashCode(),
            title = data["title"].orEmpty().ifBlank { fallbackTitle },
            body = data["body"].orEmpty(),
        )
    }
}

internal object ReiNotifications {
    private const val Channel = "rei_activity"
    private const val Open = "dev.rei.android.OPEN_NOTIFICATION"
    private const val Device = "device"
    private const val Session = "session"
    private const val Message = "message"
    private const val Enabled = "enabled"
    private const val ChannelId = "channelId"
    private const val Server = "server"
    private val updates = Mutex()

    private fun preferences(context: Context) = context.getSharedPreferences("rei_notifications", Context.MODE_PRIVATE)
    fun enabled(context: Context): Boolean = preferences(context).getBoolean(Enabled, false)
    fun hasPermission(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /** Creates the notification channel if it is missing. Android 13+ lists it in the app's notification settings only once it exists. */
    fun ensureChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(
                NotificationChannel(Channel, context.getString(R.string.notification_channel_activity), NotificationManager.IMPORTANCE_DEFAULT),
            )
    }

    fun setEnabled(context: Context, enabled: Boolean) {
        preferences(context).edit { putBoolean(Enabled, enabled) }
        if (enabled) {
            ensureChannel(context)
            ReiFirebase.sync(context)
        } else {
            context.getSystemService(NotificationManager::class.java).cancelAll()
            ReiFirebase.disable(context)
        }
    }

    fun signedOut(context: Context) {
        preferences(context).edit { remove(Device).remove(Server).remove(ChannelId) }
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    suspend fun register(context: Context, token: String) = updates.withLock {
        if (!enabled(context) || !hasPermission(context)) return@withLock
        val saved = CredentialStore(context).load() ?: return@withLock
        val credential = saved.token ?: return@withLock
        val api = ReiApi(saved.serverUrl, credential)
        val auth = api.request("GET", listOf("api", "auth", "state"))
        val device = auth.optionalString("deviceId") ?: return@withLock
        val reply = api.request("POST", listOf("api", "devices", "current", "channels"), buildJsonObject {
            put("kind", "fcm")
            put("token", token)
        })["channel"] as? JsonObject ?: return@withLock
        val current = CredentialStore(context).load()
        if (current?.token != credential || current.serverUrl != saved.serverUrl) return@withLock
        preferences(context).edit {
            putString(Device, device).putString(Server, saved.serverUrl).putString(ChannelId, reply.optionalString("id"))
        }
    }

    suspend fun unregister(context: Context) = updates.withLock {
        val prefs = preferences(context)
        val id = prefs.getString(ChannelId, null) ?: return@withLock
        val saved = CredentialStore(context).load() ?: return@withLock
        if (saved.token == null || saved.serverUrl != prefs.getString(Server, null)) return@withLock
        ReiApi(saved.serverUrl, saved.token).request("DELETE", listOf("api", "devices", "current", "channels", id))
        prefs.edit { remove(ChannelId) }
    }

    private fun matchesDevice(context: Context, device: String?): Boolean =
        device != null && device == preferences(context).getString(Device, null) &&
            CredentialStore(context).load()?.let { it.token != null && it.serverUrl == preferences(context).getString(Server, null) } == true

    suspend fun open(context: Context, intent: Intent): NotificationTarget? {
        if (intent.action != Open) return null
        val device = intent.getStringExtra(Device)
        val matched = withContext(Dispatchers.IO) { matchesDevice(context, device) }
        if (!matched) return null
        val session = intent.getStringExtra(Session).orEmpty()
        return NotificationTarget(session, intent.getStringExtra(Message))
    }

    fun show(context: Context, data: Map<String, String>) {
        if (!enabled(context) || !hasPermission(context) || !matchesDevice(context, data["deviceId"])) return
        val manager = context.getSystemService(NotificationManager::class.java)
        ensureChannel(context)
        val session = data["sessionId"].orEmpty()
        val message = data["messageId"]
        val content = NotificationContent.from(data, context.getString(R.string.app_name))
        val id = content.id
        val destination = Intent(context, MainActivity::class.java).apply {
            action = Open
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(Device, data["deviceId"])
            putExtra(Session, session)
            putExtra(Message, message)
        }
        val action = PendingIntent.getActivity(context, id, destination, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val title = content.title
        val body = content.body
        manager.notify(id, Notification.Builder(context, Channel)
            .setSmallIcon(dev.rei.android.R.drawable.ic_rei_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(action)
            .build())
    }
}
