package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApiException
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.text.NumberFormat
import java.util.Date

/** Loaded data for a settings screen: [value] until it arrives is null; [reload] fetches again and keeps the old value showing. */
@Stable
class Resource<T> internal constructor(
    private val state: androidx.compose.runtime.MutableState<T?>,
    private val errorState: androidx.compose.runtime.MutableState<String?>,
    private val loadingState: androidx.compose.runtime.MutableState<Boolean>,
    private val revision: androidx.compose.runtime.MutableIntState,
) {
    val value: T? get() = state.value
    val error: String? get() = errorState.value
    val loading: Boolean get() = loadingState.value
    fun reload() { revision.intValue++ }
    fun set(value: T?) { state.value = value }
}

@Composable
fun <T> rememberResource(key: Any?, load: suspend () -> T): Resource<T> {
    val state = remember(key) { mutableStateOf<T?>(null) }
    val error = remember(key) { mutableStateOf<String?>(null) }
    val loading = remember(key) { mutableStateOf(true) }
    val revision = remember(key) { mutableIntStateOf(0) }
    LaunchedEffect(key, revision.intValue) {
        loading.value = true
        try {
            state.value = load()
            error.value = null
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            error.value = settingsError(failure)
        } finally {
            loading.value = false
        }
    }
    return remember(key) { Resource(state, error, loading, revision) }
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
    val scope = rememberCoroutineScope()
    return remember { Writes(scope) }
}

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
    Column(modifier.fillMaxSize()) {
        ReiTopBar(title, scrolled = scroll.value > 0, onBack = onBack, actions = actions)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()) else androidx.compose.foundation.layout.Spacer(Modifier.padding(top = 4.dp))
        Column(
            Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 16.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (error != null) StatusBanner(error, kind = StatusKind.Error, actionLabel = onRetry?.let { "Try again" }, onAction = onRetry)
            content()
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
