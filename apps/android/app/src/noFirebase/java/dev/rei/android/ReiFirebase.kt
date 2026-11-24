package dev.rei.android

import android.app.Service
import android.content.Context
import android.content.Intent

internal object ReiFirebase {
    fun initialize(context: Context) = Unit
    fun configured(context: Context): Boolean = false
    fun sync(context: Context) = Unit
    fun disable(context: Context) = Unit
}

class ReiFirebaseService : Service() {
    override fun onBind(intent: Intent?) = null
}
