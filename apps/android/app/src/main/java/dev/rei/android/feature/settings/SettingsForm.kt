package dev.rei.android.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes

/** One option of a [ChoiceRow]: the value the server stores and the words the user sees. */
internal data class Choice(val value: String, val label: String, val summary: String? = null, val enabled: Boolean = true)

/**
 * A settings row that shows its current choice and opens a sheet to change it: the phone's replacement for the web's select.
 * [selected] is matched against [choices]; when it matches nothing the row shows [placeholder].
 */
@Composable
internal fun ChoiceRow(
    title: String,
    selected: String?,
    choices: List<Choice>,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    summary: String? = null,
    placeholder: String = "Not set",
    enabled: Boolean = true,
    dividerBelow: Boolean = false,
) {
    var open by remember { mutableStateOf(false) }
    val current = choices.firstOrNull { it.value == selected }
    SettingsRow(
        title = title,
        modifier = modifier,
        icon = icon,
        summary = listOfNotNull(current?.label ?: placeholder, summary).joinToString("\n"),
        onClick = if (enabled) ({ open = true }) else null,
        dividerBelow = dividerBelow,
        trailing = { SettingsChevron() },
    )
    if (open) {
        ReiSheet(onDismiss = { open = false }, title = title) {
            choices.forEach { choice ->
                SettingsRow(
                    choice.label,
                    summary = choice.summary,
                    onClick = if (choice.enabled) ({ open = false; if (choice.value != selected) onSelect(choice.value) }) else null,
                    trailing = if (choice.value == selected) ({ androidx.compose.material3.Icon(ReiIcons.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary) }) else null,
                )
            }
        }
    }
}

/** A card of form fields: [content] sits in a padded column, for text fields and buttons that do not fit a row. */
@Composable
internal fun FormGroup(
    modifier: Modifier = Modifier,
    title: String? = null,
    note: String? = null,
    content: @Composable () -> Unit,
) {
    SettingsGroup(modifier = modifier, title = title) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (note != null) Text(note, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}

/** A text field for a whole number; the keyboard is numeric. [error] shows under it. */
@Composable
internal fun NumberField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    error: String? = null,
    enabled: Boolean = true,
    placeholder: String? = null,
) {
    ReiTextField(
        value = value,
        onValueChange = { onValueChange(it.filter(Char::isDigit).take(12)) },
        label = label,
        modifier = modifier,
        supportingText = supportingText,
        error = error,
        enabled = enabled,
        placeholder = placeholder,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

/** A primary or quiet button, full width, at least 48dp tall, fully rounded as the app's other buttons. */
@Composable
internal fun FormButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, primary: Boolean = true) {
    val sizing = modifier.fillMaxWidth().heightIn(min = 48.dp)
    if (primary) Button(onClick, sizing, enabled = enabled, shape = ReiShapes.Pill) { Text(label) }
    else OutlinedButton(onClick, sizing, enabled = enabled, shape = ReiShapes.Pill) { Text(label) }
}

/**
 * A write-only secret field (API key, token): masked, no autocorrect, never prefilled. Callers keep the typed text only until
 * the request that carries it has been sent.
 */
@Composable
internal fun SecretField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    supportingText: String? = null,
    placeholder: String? = null,
    enabled: Boolean = true,
) {
    ReiTextField(
        value = value,
        onValueChange = onValueChange,
        label = label,
        modifier = modifier,
        supportingText = supportingText,
        placeholder = placeholder,
        enabled = enabled,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
    )
}

/**
 * Opens an http(s) address in the system browser (a Custom Tab), for the one step that must happen there, such as an OAuth
 * consent page. Returns false when nothing could open it. The address is never logged.
 */
internal fun openInBrowser(context: android.content.Context, address: String): Boolean {
    val uri = android.net.Uri.parse(address)
    if (uri.scheme != "https" && uri.scheme != "http") return false
    return try {
        androidx.browser.customtabs.CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
        true
    } catch (_: android.content.ActivityNotFoundException) {
        false
    }
}
