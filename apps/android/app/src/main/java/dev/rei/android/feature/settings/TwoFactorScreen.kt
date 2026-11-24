package dev.rei.android.feature.settings

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.autofill.ContentType
import dev.rei.android.data.ReiApi
import dev.rei.android.data.string
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.SettingsGroup
import dev.rei.android.ui.components.SettingsRow
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The six digits of an authenticator code from whatever the user typed or pasted. */
internal fun totpDigits(text: String): String = text.filter(Char::isDigit).take(6)

/**
 * Two-factor authentication: turn an authenticator on (password, then the key, then a code to confirm) or off (password and a
 * code). The password goes only to the server over the signed-in connection and is not kept after the request.
 */
@Composable
fun TwoFactorScreen(api: ReiApi, onBack: () -> Unit) {
    val context = LocalContext.current
    val writes = rememberWrites()
    val state = rememberResource(api) { api.authState().totpEnabled }
    var editing by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var enrol by remember { mutableStateOf<Pair<String, String>?>(null) } // otpauth URI to secret
    val enabled = state.value
    fun reset() { editing = false; enrol = null; password = ""; code = "" }
    SubScreen("Two-factor authentication", onBack, busy = writes.busy || state.loading, error = writes.error ?: state.error, onRetry = state::reload) {
        if (enabled != null) {
            SettingsGroup {
                SettingsRow(
                    if (enabled) "Enabled" else "Off",
                    summary = if (enabled) "Sign in with your password and an authenticator code." else "Sign in with your password. Add an authenticator for an extra sign-in step.",
                )
            }
            if (!editing) {
                FormGroup {
                    FormButton(if (enabled) "Disable two-factor authentication" else "Set up authenticator", { editing = true })
                }
            } else {
                FormGroup {
                    ReiTextField(
                        password, { password = it }, "Current password", enabled = !writes.busy,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        contentType = ContentType.Password,
                    )
                    enrol?.let { (uri, secret) ->
                        Text("Add this key to your authenticator app:", style = MaterialTheme.typography.bodyMedium)
                        SelectionContainer { Text(secret, style = MaterialTheme.typography.titleMedium) }
                        FormButton("Open in authenticator app", primary = false, onClick = {
                            try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)))
                            } catch (_: ActivityNotFoundException) {
                                Toast.makeText(context, "No authenticator app found. Enter the key by hand.", Toast.LENGTH_LONG).show()
                            }
                        })
                        Text("Two-factor authentication stays off until you confirm a code.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (enabled || enrol != null) {
                        ReiTextField(
                            code, { code = totpDigits(it) }, "6-digit code", enabled = !writes.busy,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            contentType = ContentType.SmsOtpCode,
                        )
                    }
                    FormButton(
                        if (enabled) "Disable authenticator" else if (enrol != null) "Enable authenticator" else "Continue",
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
                    FormButton("Cancel", primary = false, enabled = !writes.busy, onClick = ::reset)
                }
            }
        }
    }
}
