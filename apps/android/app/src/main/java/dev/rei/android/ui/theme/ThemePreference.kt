package dev.rei.android.ui.theme

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Settings → Appearance. `System` follows the device and is the default. */
enum class ThemePreference(val label: String) {
    System("System"),
    Light("Light"),
    Dark("Dark");

    companion object {
        fun parse(value: String?): ThemePreference = entries.firstOrNull { it.name == value } ?: System
    }
}

/** The theme choice, stored per device (it is deliberately not tied to a server or an account). */
class ThemePreferenceStore private constructor(private val preferences: SharedPreferences) {
    private val mutable = MutableStateFlow(ThemePreference.parse(preferences.getString(Key, null)))
    val preference: StateFlow<ThemePreference> = mutable.asStateFlow()

    fun set(value: ThemePreference) {
        preferences.edit { putString(Key, value.name) }
        mutable.value = value
    }

    companion object {
        private const val File = "rei_appearance"
        private const val Key = "theme"
        @Volatile private var instance: ThemePreferenceStore? = null

        fun get(context: Context): ThemePreferenceStore = instance ?: synchronized(this) {
            instance ?: ThemePreferenceStore(
                context.applicationContext.getSharedPreferences(File, Context.MODE_PRIVATE),
            ).also { instance = it }
        }
    }
}
