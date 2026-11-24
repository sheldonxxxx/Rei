package dev.rei.android.feature.settings

import java.text.NumberFormat

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
internal fun rangeMessage(label: String, min: Long, max: Long?): String =
    if (max == null) "“$label” must be a whole number, ${grouped(min)} or more."
    else "“$label” must be a whole number from ${grouped(min)} to ${grouped(max)}."

internal fun grouped(value: Long): String = NumberFormat.getIntegerInstance(java.util.Locale.US).format(value)

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
internal fun limitSource(source: String?): String = when (source) {
    "custom" -> "Set by you"
    "detected" -> "Reported by the provider"
    "built_in" -> "Built-in default"
    else -> "Not reported. Enter a value if you know it."
}

/** `connectionId/model` has a connection to scan; a bare OpenAI model id does not. */
internal fun connectionOf(model: String): String? = model.substringBefore('/', "").takeIf { it.isNotEmpty() && '/' in model }

/**
 * The sandbox whitelist as the user edits it: entries are trimmed, compared without case, and capped. Returns the new list or
 * the sentence to show; the server still validates every entry on save.
 */
internal sealed interface AddEntry {
    data class Added(val entries: List<String>) : AddEntry
    data class Refused(val reason: String) : AddEntry
    data object Nothing : AddEntry
}

internal const val MaxWhitelistEntries = 200

internal fun addWhitelistEntry(entries: List<String>, draft: String): AddEntry {
    val text = draft.trim()
    if (text.isEmpty()) return AddEntry.Nothing
    if (entries.any { it.equals(text, ignoreCase = true) }) return AddEntry.Refused("“$text” is already on the list.")
    if (entries.size >= MaxWhitelistEntries) return AddEntry.Refused("The list holds at most $MaxWhitelistEntries entries.")
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
