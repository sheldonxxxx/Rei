package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.currentCompositeKeyHashCode
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.data.ReiApiException
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date

/** Loaded data for a settings screen: [value] until it arrives is null; [reload] fetches again and keeps the old value showing. */
@Stable
class Resource<T> internal constructor(
    private val state: MutableState<T?>,
    private val errorState: MutableState<String?>,
    private val loadingState: MutableState<Boolean>,
    private val onReload: () -> Unit,
) {
    val value: T? get() = state.value
    val error: String? get() = errorState.value
    val loading: Boolean get() = loadingState.value
    fun reload() = onReload()
    fun set(value: T?) { state.value = value }
}

/**
 * Per-destination ViewModel backing Settings screens so network loads, in-flight writes, and form edits survive
 * configuration changes instead of aborting in composition scopes.
 */
class SettingsScreenViewModel : ViewModel() {
    val writes = Writes(viewModelScope)
    private val resources = mutableMapOf<Int, Entry<Any?>>()
    private val states = mutableMapOf<Int, MutableState<Any?>>()

    private class Entry<T>(var key: Any?, private val scope: CoroutineScope, var loader: suspend () -> T) {
        val state = mutableStateOf<T?>(null)
        val error = mutableStateOf<String?>(null)
        val loading = mutableStateOf(true)
        var job: Job? = null
        val resource = Resource(state, error, loading) { start() }

        fun start() {
            job?.cancel()
            loading.value = true
            job = scope.launch {
                try {
                    state.value = loader()
                    error.value = null
                } catch (failure: CancellationException) {
                    throw failure
                } catch (failure: Exception) {
                    error.value = settingsError(failure)
                } finally {
                    loading.value = false
                }
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    internal fun <T> resource(slot: Int, key: Any?, load: suspend () -> T): Resource<T> {
        val existing = resources[slot] as? Entry<T>
        if (existing == null) {
            val created = Entry(key, viewModelScope, load)
            resources[slot] = created as Entry<Any?>
            created.start()
            return created.resource
        }
        existing.loader = load
        if (existing.key != key) {
            existing.key = key
            existing.state.value = null
            existing.error.value = null
            existing.start()
        }
        return existing.resource
    }

    @Suppress("UNCHECKED_CAST")
    internal fun <T> state(slot: Int, init: () -> T): MutableState<T> =
        states.getOrPut(slot) { mutableStateOf(init() as Any?) } as MutableState<T>
}

@Composable
fun <T> rememberResource(key: Any?, load: suspend () -> T): Resource<T> {
    val vm: SettingsScreenViewModel = viewModel()
    val slot = currentCompositeKeyHashCode.hashCode()
    return vm.resource(slot, key, load)
}

@Composable
internal fun <T> rememberSettingsState(init: () -> T): MutableState<T> {
    val vm: SettingsScreenViewModel = viewModel()
    val slot = currentCompositeKeyHashCode.hashCode()
    return vm.state(slot, init)
}

/** Single-flight writes for a settings screen: [busy] while one runs, [error] after one failed. */
@Stable
class Writes(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)

    /** Runs [block]; on success calls [onDone]. Ignored while another write is running. */
    fun run(onDone: () -> Unit = {}, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                block()
                onDone()
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                error = settingsError(failure)
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberWrites(): Writes {
    val vm: SettingsScreenViewModel = viewModel()
    return vm.writes
}

/** Set true inside expanded two-pane detail slots so the detail pane hides a redundant Back arrow. */
internal val LocalSubScreenHideBack = staticCompositionLocalOf { false }

/**
 * The frame of a native settings sub-screen: the shell top bar with a back arrow, a progress line while something loads
 * or saves, a banner for the last error, then the scrolling [content] (groups and rows).
 */
@Composable
fun SubScreen(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    busy: Boolean = false,
    error: String? = null,
    onRetry: (() -> Unit)? = null,
    actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit = {},
    content: @Composable () -> Unit,
) {
    val scroll = rememberScrollState()
    val hideBack = LocalSubScreenHideBack.current
    Column(modifier.fillMaxSize()) {
        ReiTopBar(title, scrolled = scroll.value > 0, onBack = if (hideBack) null else onBack, actions = actions)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 4.dp))
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            Column(
                Modifier
                    .widthIn(max = 760.dp)
                    .fillMaxWidth()
                    .verticalScroll(scroll)
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                if (error != null) StatusBanner(error, kind = StatusKind.Error, actionLabel = onRetry?.let { "Try again" }, onAction = onRetry)
                content()
            }
        }
    }
}

internal fun settingsError(failure: Exception): String =
    (failure as? ReiApiException)?.message ?: failure.message ?: "Couldn’t complete that. Try again."

/** A stored millisecond timestamp as a short local date and time, or null when absent. */
internal fun dateTime(millis: Long?): String? = millis?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it)) }

internal fun count(value: Long?): String = value?.let { NumberFormat.getIntegerInstance().format(it) } ?: "—"

/**
 * A count with the web app's K, M, B and T abbreviations: one decimal at most, no trailing zero, halves rounded up, so 1,000
 * is "1K", 1,150 is "1.2K", 999,950 is "1M" and anything under 1,000 is written out. Mirrors `Intl.NumberFormat("en-US",
 * { notation: "compact", maximumFractionDigits: 1 })`, which the web's Usage page uses. Use it for token and usage counts.
 */
internal fun compactCount(value: Long): String {
    val thousand = java.math.BigDecimal(1_000)
    var scaled = java.math.BigDecimal(value).abs()
    if (scaled < thousand) return value.toString()
    val units = listOf("K", "M", "B", "T")
    scaled = scaled.divide(thousand)
    var unit = 0
    // A value that rounds up to 1,000 of its unit is written in the next unit: 999,950 is "1M", not "1000K".
    while (unit < units.lastIndex && scaled.setScale(1, java.math.RoundingMode.HALF_UP) >= thousand) {
        scaled = scaled.divide(thousand)
        unit++
    }
    val text = scaled.setScale(1, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()
    return (if (value < 0) "-" else "") + text + units[unit]
}
