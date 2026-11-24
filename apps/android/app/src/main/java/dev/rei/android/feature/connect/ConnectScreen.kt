package dev.rei.android.feature.connect

import android.app.Activity
import android.os.Build
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.rei.android.BuildConfig
import dev.rei.android.ReiUiState
import dev.rei.android.data.AuthState
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiPortrait
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

/**
 * Connect, sign in, first-run setup and "update the app" in one screen. Step 1 asks for the server address; step 2 asks
 * for the password and, when the account has two-factor on (or on first run), the code. Errors show under the field they
 * belong to; only what no field explains shows as a banner.
 */
@Composable
fun ConnectScreen(
    state: ReiUiState,
    onConnect: (String) -> Unit,
    onSignIn: (String, String, String) -> Unit,
    onChangeServer: () -> Unit,
    onPasskey: (Activity, String) -> Unit = { _, _ -> },
) {
    var url by rememberSaveable { mutableStateOf(state.serverUrl) }
    var tried by rememberSaveable { mutableStateOf(false) }
    var password by remember(state.auth) { mutableStateOf("") }
    var code by remember(state.auth) { mutableStateOf("") }
    var showPassword by remember(state.auth) { mutableStateOf(false) }
    var label by rememberSaveable { mutableStateOf(Build.MODEL.orEmpty().take(60).ifBlank { "Android" }) }
    val activity = LocalActivity.current
    val focus = LocalFocusManager.current
    val auth = state.auth
    val setup = auth?.setupRequired == true
    val needsCode = setup || auth?.totpEnabled == true
    val working = state.working

    LaunchedEffect(state.serverUrl) { if (state.serverUrl.isNotEmpty()) url = state.serverUrl }

    val cleartext = BuildConfig.DEBUG
    val urlProblem = ServerAddress.validate(url, cleartext)
    // Errors from the server land under the field that explains them.
    val serverError = state.error
    val code0 = state.errorCode
    val connectError = if (auth == null && !state.upgradeRequired) serverError else null
    val setupCodeError = if (setup && code0 == "bad_setup_code") serverError else null
    val passwordError = when {
        auth == null -> null
        code0 == "weak_password" || code0 == "bad_credentials" -> serverError
        else -> null
    }
    val authenticatorError = if (!setup && code0 == "bad_totp") serverError else null
    val banner = when {
        state.upgradeRequired -> serverError ?: "Update Rei for Android to connect to this server."
        serverError == null -> null
        connectError != null || setupCodeError != null || passwordError != null || authenticatorError != null -> null
        else -> serverError
    }

    fun connect() {
        tried = true
        if (url.isNotBlank() && urlProblem == null) { focus.clearFocus(); onConnect(url.trim()) }
    }
    val canSignIn = !working && password.isNotEmpty() && label.isNotBlank() &&
        (!setup || password.length >= 12) &&
        (!needsCode || if (setup) code.isNotBlank() else code.length == 6)
    fun signIn() { if (canSignIn) { focus.clearFocus(); onSignIn(password, code, label) } }

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).systemBarsPadding().imePadding()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.weight(0.8f))
            ReiPortrait(size = 88.dp)
            Text("Rei", Modifier.padding(top = 12.dp), color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.headlineLarge)
            Spacer(Modifier.heightIn(min = 24.dp).weight(0.5f))
            Surface(
                modifier = Modifier.widthIn(max = 440.dp).fillMaxWidth(),
                shape = ReiShapes.Card,
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            when {
                                state.upgradeRequired -> "Update Rei for Android"
                                auth == null -> "Connect to your Rei server"
                                setup -> "Set up Rei"
                                else -> "Sign in to Rei"
                            },
                            style = MaterialTheme.typography.titleLarge,
                        )
                        if (!state.upgradeRequired) {
                            Text(
                                if (auth == null) "Step 1 of 2 · Server" else "Step 2 of 2 · Account",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    if (banner != null) StatusBanner(banner, kind = StatusKind.Error)
                    if (working) LinearProgressIndicator(Modifier.fillMaxWidth())
                    if (auth == null) {
                        ReiTextField(
                            value = url,
                            onValueChange = { url = it; tried = false },
                            label = "Rei server address",
                            placeholder = "https://rei.example.com",
                            enabled = !working,
                            error = connectError ?: urlProblem?.takeIf { tried || url.trim().startsWith("http://") || url.contains(' ') },
                            supportingText = ServerAddress.hint(url, cleartext) ?: "The address of the Rei you run.",
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { connect() }),
                            contentType = ContentType.Username,
                        )
                        Button(
                            onClick = ::connect,
                            enabled = !working && url.isNotBlank() && (urlProblem == null),
                            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                            shape = ReiShapes.Pill,
                        ) { Text("Connect") }
                    } else {
                        Text(state.serverUrl, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (setup) {
                            ReiTextField(
                                value = code,
                                onValueChange = { code = it },
                                label = "Setup code",
                                enabled = !working,
                                error = setupCodeError,
                                supportingText = "Printed in the server log the first time it starts.",
                                visualTransformation = PasswordVisualTransformation(),
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                            )
                        }
                        ReiTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = if (setup) "New password" else "Password",
                            enabled = !working,
                            error = passwordError,
                            supportingText = if (setup) "Use at least 12 characters." else null,
                            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Password,
                                autoCorrectEnabled = false,
                                imeAction = if (needsCode && !setup) ImeAction.Next else ImeAction.Done,
                            ),
                            keyboardActions = KeyboardActions(onDone = { signIn() }),
                            contentType = if (setup) ContentType.NewPassword else ContentType.Password,
                            trailingContent = {
                                ReiIconButton(
                                    if (showPassword) ReiIcons.EyeOff else ReiIcons.Eye,
                                    if (showPassword) "Hide password" else "Show password",
                                    { showPassword = !showPassword },
                                )
                            },
                        )
                        if (needsCode && !setup) {
                            ReiTextField(
                                value = code,
                                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                                label = "Authenticator code",
                                enabled = !working,
                                error = authenticatorError,
                                supportingText = "The 6 digits from your authenticator app.",
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { signIn() }),
                                contentType = ContentType.SmsOtpCode,
                            )
                        }
                        ReiTextField(
                            value = label,
                            onValueChange = { label = it.take(60) },
                            label = "Device name",
                            enabled = !working,
                            supportingText = "Shown in Settings → Devices so you can sign it out later.",
                        )
                        Button(
                            onClick = ::signIn,
                            enabled = canSignIn,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                            shape = ReiShapes.Pill,
                        ) { Text(if (setup) "Set up Rei" else "Sign in") }
                        if (activity != null && auth.passkeys && state.serverUrl.startsWith("https://")) {
                            OutlinedButton(
                                onClick = { onPasskey(activity, label) },
                                enabled = !working && label.isNotBlank(),
                                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
                                shape = ReiShapes.Pill,
                            ) {
                                androidx.compose.material3.Icon(ReiIcons.Key, contentDescription = null, modifier = Modifier.padding(end = 8.dp))
                                Text("Use a passkey")
                            }
                        }
                    }
                }
            }
            if (auth != null) {
                TextButton(onClick = onChangeServer, enabled = !working, modifier = Modifier.padding(top = 4.dp)) { Text("Change server") }
            }
            Spacer(Modifier.weight(1f))
            if (!state.upgradeRequired) {
                Text(
                    "Your Rei, on your own server.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 16.dp),
                )
            }
        }
    }
}

@ReiPreviews
@Composable
private fun ConnectStepOnePreview() = ReiPreviewSurface { ConnectScreen(ReiUiState(), {}, { _, _, _ -> }, {}) }

@ReiPreviews
@Composable
private fun ConnectSignInPreview() = ReiPreviewSurface {
    ConnectScreen(
        ReiUiState(
            serverUrl = "https://rei.example.com",
            auth = AuthState(setupRequired = false, signedIn = false, totpEnabled = true, passkeys = true),
            error = "The password or code is wrong.",
            errorCode = "bad_credentials",
        ),
        {}, { _, _, _ -> }, {},
    )
}
