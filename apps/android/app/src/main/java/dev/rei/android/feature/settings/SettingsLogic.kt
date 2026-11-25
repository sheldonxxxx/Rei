package dev.rei.android.feature.settings

import dev.rei.android.R
import dev.rei.android.ui.UiText
import java.text.NumberFormat
import java.util.Locale

/**
 * Pure rules the native settings forms share with the web's: how a typed number is read, how a list entry is checked, how a
 * server limit reads in words. They live apart from the screens so they can be tested without a device.
 */

/** A whole number from a form field, or null when the text is not one or is outside [min]..[max]. */
internal fun parseWholeNumber(text: String, min: Long, max: Long? = null): Long? {
    val trimmed = text.trim()
    if (trimmed.isEmpty() || trimmed.length > 18 || !trimmed.all(Char::isDigit)) return null
    val value = trimmed.toLong()
    return value.takeIf { it >= min && (max == null || it <= max) }
}

/** The web's message for a number outside its range, so the two clients refuse the same input in the same words. */
internal fun rangeMessage(label: UiText, min: Long, max: Long?): UiText =
    if (max == null) UiText.Resource(R.string.settings_range_min, label, grouped(min))
    else UiText.Resource(R.string.settings_range_between, label, grouped(min), grouped(max))

internal fun grouped(value: Long): String = NumberFormat.getIntegerInstance(Locale.getDefault()).format(value)

/** A model-limit override from the Models screen: empty clears it (null), a positive whole number sets it, anything else is invalid. */
internal sealed interface LimitInput {
    data object Clear : LimitInput
    data class Value(val tokens: Long) : LimitInput
    data object Invalid : LimitInput
}

internal fun parseLimit(text: String): LimitInput {
    if (text.isBlank()) return LimitInput.Clear
    val value = parseWholeNumber(text, 1) ?: return LimitInput.Invalid
    return LimitInput.Value(value)
}

/** Where a model limit came from, in the web's words. */
internal fun limitSource(source: String?): UiText = when (source) {
    "custom" -> UiText.Resource(R.string.settings_limit_source_custom)
    "detected" -> UiText.Resource(R.string.settings_limit_source_detected)
    "built_in" -> UiText.Resource(R.string.settings_limit_source_built_in)
    else -> UiText.Resource(R.string.settings_limit_source_unknown)
}

/** `connectionId/model` has a connection to scan; a bare OpenAI model id does not. */
internal fun connectionOf(model: String): String? = model.substringBefore('/', "").takeIf { it.isNotEmpty() && '/' in model }

/**
 * The sandbox whitelist as the user edits it: entries are trimmed, compared without case, and capped. Returns the new list or
 * the sentence to show; the server still validates every entry on save.
 */
internal sealed interface AddEntry {
    data class Added(val entries: List<String>) : AddEntry
    data class Refused(val reason: UiText) : AddEntry
    data object Nothing : AddEntry
}

internal const val MaxWhitelistEntries = 200

internal fun addWhitelistEntry(entries: List<String>, draft: String): AddEntry {
    val text = draft.trim()
    if (text.isEmpty()) return AddEntry.Nothing
    if (entries.any { it.equals(text, ignoreCase = true) }) {
        return AddEntry.Refused(UiText.Resource(R.string.settings_whitelist_duplicate, text))
    }
    if (entries.size >= MaxWhitelistEntries) {
        return AddEntry.Refused(UiText.Resource(R.string.settings_whitelist_cap, MaxWhitelistEntries))
    }
    return AddEntry.Added(entries + text)
}

/** A search or model id as the server accepts it: letters, digits, dot, dash, underscore, up to 100 characters. */
internal fun isSearchModelId(text: String): Boolean = text.isNotEmpty() && text.length <= 100 && text.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }

/** Move [index] by [delta] inside [list]; returns the list unchanged when the move would leave it. */
internal fun <T> List<T>.moved(index: Int, delta: Int): List<T> {
    val to = index + delta
    if (index !in indices || to !in indices) return this
    return toMutableList().also { it.add(to, it.removeAt(index)) }
}
