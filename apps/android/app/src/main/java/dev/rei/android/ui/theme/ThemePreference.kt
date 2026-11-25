package dev.rei.android.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.annotation.StringRes
import androidx.core.content.edit
import dev.rei.android.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Settings → Appearance. `System` follows the device and is the default. */
enum class ThemePreference(@StringRes val labelRes: Int) {
    System(R.string.theme_system),
    Light(R.string.theme_light),
    Dark(R.string.theme_dark);

    companion object {
        fun parse(value: String?): ThemePreference = entries.firstOrNull { it.name == value } ?: System
    }
}

/** The theme choice, stored per device (it is deliberately not tied to a server or an account). */
class ThemePreferenceStore private constructor(
    private val context: Context,
    private val preferences: SharedPreferences,
) {
    private val mutable = MutableStateFlow(ThemePreference.parse(preferences.getString(Key, null)))
    val preference: StateFlow<ThemePreference> = mutable.asStateFlow()

    init {
        applyNightMode(mutable.value)
    }

    fun set(value: ThemePreference) {
        preferences.edit { putString(Key, value.name) }
        mutable.value = value
        applyNightMode(value)
    }

    private fun applyNightMode(value: ThemePreference) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val mode = when (value) {
                ThemePreference.System -> UiModeManager.MODE_NIGHT_AUTO
                ThemePreference.Light -> UiModeManager.MODE_NIGHT_NO
                ThemePreference.Dark -> UiModeManager.MODE_NIGHT_YES
            }
            context.getSystemService(UiModeManager::class.java)?.setApplicationNightMode(mode)
        }
    }

    companion object {
        private const val File = "rei_appearance"
        private const val Key = "theme"
        @Volatile private var instance: ThemePreferenceStore? = null

        fun get(context: Context): ThemePreferenceStore = instance ?: synchronized(this) {
            val app = context.applicationContext
            instance ?: ThemePreferenceStore(
                app,
                app.getSharedPreferences(File, Context.MODE_PRIVATE),
            ).also { instance = it }
        }
    }
}
