package dev.rei.android.ui

import android.content.Context
import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

/**
 * Text resolved at the UI boundary so ViewModels and pure-Kotlin formatters stay Context-free and unit-testable.
 */
@Immutable
sealed interface UiText {
    @Immutable
    data class Literal(val value: String) : UiText

    @Immutable
    data class Resource(@StringRes val id: Int, val args: List<Any> = emptyList()) : UiText {
        constructor(@StringRes id: Int, vararg args: Any) : this(id, args.toList())
    }

    @Immutable
    data class Plural(@PluralsRes val id: Int, val count: Int, val args: List<Any> = emptyList()) : UiText {
        constructor(@PluralsRes id: Int, count: Int, vararg args: Any) : this(id, count, args.toList())
    }

    fun asString(context: Context): String = asString(context.resources)

    fun asString(resources: Resources): String = when (this) {
        is Literal -> value
        is Resource -> if (args.isEmpty()) {
            resources.getString(id)
        } else {
            val resolved = args.map { if (it is UiText) it.asString(resources) else it }.toTypedArray()
            resources.getString(id, *resolved)
        }
        is Plural -> if (args.isEmpty()) {
            resources.getQuantityString(id, count)
        } else {
            val resolved = args.map { if (it is UiText) it.asString(resources) else it }.toTypedArray()
            resources.getQuantityString(id, count, *resolved)
        }
    }

    @Composable
    fun asString(): String = when (this) {
        is Literal -> value
        is Resource -> if (args.isEmpty()) {
            stringResource(id)
        } else {
            val resolved = args.map { if (it is UiText) it.asString() else it }.toTypedArray()
            stringResource(id, *resolved)
        }
        is Plural -> if (args.isEmpty()) {
            pluralStringResource(id, count)
        } else {
            val resolved = args.map { if (it is UiText) it.asString() else it }.toTypedArray()
            pluralStringResource(id, count, *resolved)
        }
    }
}

interface HasUiText {
    val uiText: UiText
}

class ReiInputException(
    override val uiText: UiText,
    message: String = "",
) : IllegalArgumentException(message), HasUiText

class ReiStateException(
    override val uiText: UiText,
    message: String = "",
) : IllegalStateException(message), HasUiText

fun Throwable.asUiText(fallback: UiText): UiText = when {
    this is HasUiText -> uiText
    !localizedMessage.isNullOrBlank() -> UiText.Literal(localizedMessage!!)
    else -> fallback
}
