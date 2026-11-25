package dev.rei.android.update

/**
 * Holds the installer's confirmation screen until Rei can show it. Since Android 10 an app may start an activity only while
 * it has a visible window, so launching from the install-status receiver can be dropped silently while the app is in the
 * background. [offer] launches at once when Rei is in the foreground and otherwise keeps the item for [onForeground].
 *
 * Generic over the item so that the rules run in plain unit tests (the app uses it with an `Intent`).
 */
internal class ConfirmationGate<T : Any>(private val launch: (T) -> Unit) {
    enum class Outcome { Launched, Deferred, Blocked }

    private var foreground = false
    private var pending: T? = null

    val hasPending: Boolean get() = pending != null

    fun offer(item: T): Outcome {
        if (!foreground) {
            pending = item
            return Outcome.Deferred
        }
        return start(item)
    }

    /** Rei is visible again: shows a confirmation that arrived in the background, if any. Null when none was waiting. */
    fun onForeground(): Outcome? {
        foreground = true
        val item = pending ?: return null
        pending = null
        return start(item)
    }

    fun onBackground() {
        foreground = false
    }

    /** The install finished or was cancelled, so a retained confirmation is stale. */
    fun clear() {
        pending = null
    }

    private fun start(item: T): Outcome = try {
        launch(item)
        Outcome.Launched
    } catch (_: Exception) {
        Outcome.Blocked
    }
}
