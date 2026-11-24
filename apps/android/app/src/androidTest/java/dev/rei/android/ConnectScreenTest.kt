package dev.rei.android

import android.content.Context
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import dev.rei.android.data.AuthState
import dev.rei.android.feature.connect.ConnectScreen
import dev.rei.android.ui.UiText
import dev.rei.android.ui.theme.ReiTheme
import org.junit.Rule
import org.junit.Test

class ConnectScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val context: Context
        get() = ApplicationProvider.getApplicationContext()

    private fun str(id: Int, vararg args: Any) = context.getString(id, *args)

    @Test
    fun connectNeedsServerAddress() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(ReiUiState(), {}, { _, _, _ -> }, {})
            }
        }
        compose.onNodeWithText(str(R.string.connect_action_connect), substring = false).assertIsNotEnabled()
        compose.onNodeWithText(str(R.string.connect_server_label)).performTextInput("https://rei.example.com")
        compose.onNodeWithText(str(R.string.connect_action_connect), substring = false).assertIsEnabled()
    }

    @Test
    fun authenticatorCodeIsRequiredWhenEnabled() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(
                    ReiUiState(
                        serverUrl = "https://rei.example.com",
                        auth = AuthState(setupRequired = false, signedIn = false, totpEnabled = true),
                    ),
                    {},
                    { _, _, _ -> },
                    {},
                )
            }
        }
        compose.onNodeWithText(str(R.string.connect_password_label), substring = false).performTextInput("sample password")
        compose.onNodeWithText(str(R.string.connect_action_signin), substring = false).assertIsNotEnabled()
        compose.onNodeWithText(str(R.string.connect_totp_label)).performTextInput("123456")
        compose.onNodeWithText(str(R.string.connect_action_signin), substring = false).assertIsEnabled()
    }

    @Test
    fun serverErrorShowsUnderTheFieldItBelongsTo() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(
                    ReiUiState(
                        serverUrl = "https://rei.example.com",
                        auth = AuthState(setupRequired = false, signedIn = false, totpEnabled = false),
                        error = UiText.Resource(R.string.connect_err_bad_credentials),
                        errorCode = "bad_credentials",
                    ),
                    {},
                    { _, _, _ -> },
                    {},
                )
            }
        }
        // Shown once, as the password field's supporting text, not also as a banner.
        compose.onAllNodesWithText(str(R.string.connect_err_bad_credentials)).assertCountEquals(1)
    }

    @Test
    fun passwordCanBeRevealed() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(
                    ReiUiState(
                        serverUrl = "https://rei.example.com",
                        auth = AuthState(setupRequired = false, signedIn = false, totpEnabled = false),
                    ),
                    {},
                    { _, _, _ -> },
                    {},
                )
            }
        }
        compose.onNodeWithContentDescription(str(R.string.connect_show_password)).performClick()
        compose.onNodeWithContentDescription(str(R.string.connect_hide_password)).assertExists()
    }

    @Test
    fun insecureAddressIsFlaggedInRelease() {
        var connected: String? = null
        compose.setContent { ReiTheme { ConnectScreen(ReiUiState(), { connected = it }, { _, _, _ -> }, {}) } }
        compose.onNodeWithText(str(R.string.connect_server_label)).performTextInput("http://rei.example.com")
        compose.onNodeWithText(str(R.string.connect_action_connect), substring = false).performClick()
        org.junit.Assert.assertNull(connected)
        compose.onNodeWithText(str(R.string.connect_err_https_only)).assertExists()
    }
}
