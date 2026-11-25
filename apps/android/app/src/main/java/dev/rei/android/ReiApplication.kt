package dev.rei.android

import android.app.Application
import dev.rei.android.di.AppContainer

class ReiApplication : Application() {
    val container: AppContainer by lazy { AppContainer(this) }

    override fun onCreate() {
        super.onCreate()
        ReiNotifications.ensureChannel(this)
        ReiFirebase.initialize(this)
    }
}
