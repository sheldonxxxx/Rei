package dev.rei.android.feature.chat

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * "Show details": whether chats show full tool arguments and results and the Inspect entry points, or one quiet line per
 * piece of work. The device-wide default lives here (Settings → App → "Show details by default" reads and sets it);
 * the chat's own switch changes it for the device too, as on web.
 */
class ShowDetailsStore private constructor(private val prefs: android.content.SharedPreferences) {
    private val state = MutableStateFlow(prefs.getBoolean(Key, false))
    val enabled: StateFlow<Boolean> = state.asStateFlow()

    fun set(value: Boolean) {
        prefs.edit().putBoolean(Key, value).apply()
        state.value = value
    }

    companion object {
        private const val Key = "show_details"
        @Volatile private var instance: ShowDetailsStore? = null

        fun get(context: Context): ShowDetailsStore = instance ?: synchronized(this) {
            instance ?: ShowDetailsStore(context.applicationContext.getSharedPreferences("display", Context.MODE_PRIVATE)).also { instance = it }
        }
    }
}
