package dev.rei.android.feature.settings

import android.content.ActivityNotFoundException
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.autofill.ContentType
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.string
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SecureWindow
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The authenticator link is opened only when it really is an `otpauth:` URI, whatever the server sent. */
internal fun isOtpAuthUri(uri: String): Boolean = uri.substringBefore(':', "").equals("otpauth", ignoreCase = true)

/** The six digits of an authenticator code from whatever the user typed or pasted. */
internal fun totpDigits(text: String): String = text.filter(Char::isDigit).take(6)

/**
 * Two-factor authentication: turn an authenticator on (password, then the key, then a code to confirm) or off (password and a
 * code). The password goes only to the server over the signed-in connection and is not kept after the request.
 */
@Composable
fun TwoFactorScreen(api: ReiApi, onBack: () -> Unit) {
    val resources = LocalResources.current
    val context = LocalContext.current
    val writes = rememberWrites()
    val state = rememberResource("twoFactor", api) { api.authState().totpEnabled }
    var editing by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var enrol by remember { mutableStateOf<Pair<String, String>?>(null) } // otpauth URI to secret
    val enabled = state.value
    // The authenticator key is on screen only while enrolling: keep it out of screenshots and the recent-apps thumbnail.
    SecureWindow(enabled = enrol != null)
    fun reset() { editing = false; enrol = null; password = ""; code = "" }
    SubScreen(stringResource(R.string.settings_page_two_factor), onBack, busy = writes.busy || state.loading, error = writes.error ?: state.error, onRetry = state::reload) {
        if (enabled != null) {
            SettingsGroup {
                SettingsRow(
                    stringResource(if (enabled) R.string.settings_tfa_enabled else R.string.settings_tfa_off),
                    summary = stringResource(if (enabled) R.string.settings_tfa_enabled_summary else R.string.settings_tfa_off_summary),
                )
            }
            if (!editing) {
                FormGroup {
                    FormButton(stringResource(if (enabled) R.string.settings_tfa_disable else R.string.settings_tfa_setup), { editing = true })
                }
            } else {
                FormGroup {
                    var showPassword by remember { mutableStateOf(false) }
                    ReiTextField(
                        password, { password = it }, stringResource(R.string.settings_tfa_current_password), enabled = !writes.busy,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                        contentType = ContentType.Password,
                        trailingContent = {
                            ReiIconButton(
                                if (showPassword) ReiIcons.EyeOff else ReiIcons.Eye,
                                stringResource(if (showPassword) R.string.connect_hide_password else R.string.connect_show_password),
                                { showPassword = !showPassword },
                            )
                        },
                    )
                    enrol?.let { (uri, secret) ->
                        Text(stringResource(R.string.settings_tfa_add_key), style = MaterialTheme.typography.bodyMedium)
                        SelectionContainer { Text(secret, style = MaterialTheme.typography.titleMedium) }
                        FormButton(stringResource(R.string.settings_tfa_open_app), primary = false, onClick = {
                            try {
                                if (!isOtpAuthUri(uri)) throw ActivityNotFoundException()
                                context.startActivity(Intent(Intent.ACTION_VIEW, uri.toUri()))
                            } catch (_: ActivityNotFoundException) {
                                Toast.makeText(context, resources.getString(R.string.settings_tfa_no_app), Toast.LENGTH_LONG).show()
                            }
                        })
                        Text(stringResource(R.string.settings_tfa_pending_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (enabled || enrol != null) {
                        ReiTextField(
                            code, { code = totpDigits(it) }, stringResource(R.string.settings_tfa_code_label), enabled = !writes.busy,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            contentType = ContentType.SmsOtpCode,
                        )
                    }
                    FormButton(
                        stringResource(
                            when {
                                enabled -> R.string.settings_tfa_disable_action
                                enrol != null -> R.string.settings_tfa_enable_action
                                else -> R.string.common_continue
                            },
                        ),
                        enabled = !writes.busy && password.isNotEmpty() && ((!enabled && enrol == null) || code.length == 6),
                        onClick = {
                            val pass = password
                            val totp = code
                            val starting = !enabled && enrol == null
                            writes.run({ if (!starting) { reset(); state.reload() } }) {
                                when {
                                    enabled -> api.request("POST", listOf("api", "auth", "totp", "disable"), buildJsonObject { put("password", pass); put("totpCode", totp) })
                                    enrol != null -> api.request("POST", listOf("api", "auth", "totp", "confirm"), buildJsonObject { put("password", pass); put("totpCode", totp) })
                                    else -> {
                                        val started = api.request("POST", listOf("api", "auth", "totp", "start"), buildJsonObject { put("password", pass) })
                                        enrol = started.string("totpUri") to started.string("totpSecret")
                                    }
                                }
                            }
                        },
                    )
                    FormButton(stringResource(R.string.common_cancel), primary = false, enabled = !writes.busy, onClick = ::reset)
                }
            }
        }
    }
}
