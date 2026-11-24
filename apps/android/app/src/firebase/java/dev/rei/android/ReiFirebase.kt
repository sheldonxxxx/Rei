package dev.rei.android

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.rei.android.data.string
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import java.io.IOException

internal object ReiFirebase {
    private const val Asset = "rei-firebase.json"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun initialize(context: Context) {
        if (configured(context)) return
        val raw = try {
            context.assets.open(Asset).bufferedReader().use { it.readText() }
        } catch (_: IOException) {
            return
        }
        val config = Json.parseToJsonElement(raw).jsonObject
        FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApplicationId(config.string("appId"))
            .setApiKey(config.string("apiKey"))
            .setProjectId(config.string("projectId"))
            .setGcmSenderId(config.string("senderId"))
            .build())
    }

    fun configured(context: Context) = FirebaseApp.getApps(context).isNotEmpty()

    fun sync(context: Context) {
        if (!configured(context) || !ReiNotifications.enabled(context) || !ReiNotifications.hasPermission(context)) return
        val app = context.applicationContext
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            scope.launch { runCatching { ReiNotifications.register(app, token) } }
        }
    }

    fun disable(context: Context) {
        val app = context.applicationContext
        scope.launch {
            runCatching { ReiNotifications.unregister(app) }
            if (configured(app) && !ReiNotifications.enabled(app)) FirebaseMessaging.getInstance().deleteToken()
        }
    }
}

class ReiFirebaseService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        runBlocking(Dispatchers.IO) {
            withTimeoutOrNull(8_000) { runCatching { ReiNotifications.register(applicationContext, token) } }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        ReiNotifications.show(applicationContext, message.data)
    }
}
