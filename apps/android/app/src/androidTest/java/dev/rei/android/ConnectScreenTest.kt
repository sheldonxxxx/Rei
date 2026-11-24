package dev.rei.android

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import dev.rei.android.data.AuthState
import dev.rei.android.feature.connect.ConnectScreen
import dev.rei.android.ui.theme.ReiTheme
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
import org.junit.Rule
import org.junit.Test

class ConnectScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun connectNeedsServerAddress() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(ReiUiState(), {}, { _, _, _ -> }, {})
            }
        }
        compose.onNodeWithText("Connect", substring = false).assertIsNotEnabled()
        compose.onNodeWithText("Rei server address").performTextInput("https://rei.example.com")
        compose.onNodeWithText("Connect", substring = false).assertIsEnabled()
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
        compose.onNodeWithText("Password", substring = false).performTextInput("sample password")
        compose.onNodeWithText("Sign in", substring = false).assertIsNotEnabled()
        compose.onNodeWithText("Authenticator code").performTextInput("123456")
        compose.onNodeWithText("Sign in", substring = false).assertIsEnabled()
    }

    @Test
    fun serverErrorShowsUnderTheFieldItBelongsTo() {
        compose.setContent {
            ReiTheme {
                ConnectScreen(
                    ReiUiState(
                        serverUrl = "https://rei.example.com",
                        auth = AuthState(setupRequired = false, signedIn = false, totpEnabled = false),
                        error = "The password or code is wrong.",
                        errorCode = "bad_credentials",
                    ),
                    {},
                    { _, _, _ -> },
                    {},
                )
            }
        }
        // Shown once, as the password field's supporting text, not also as a banner.
        compose.onAllNodesWithText("The password or code is wrong.").assertCountEquals(1)
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
        compose.onNodeWithContentDescription("Show password").performClick()
        compose.onNodeWithContentDescription("Hide password").assertExists()
    }

    @Test
    fun insecureAddressIsFlaggedInRelease() {
        compose.setContent { ReiTheme { ConnectScreen(ReiUiState(), {}, { _, _, _ -> }, {}) } }
        compose.onNodeWithText("Rei server address").performTextInput("rei.example.com")
        compose.onNodeWithText("Connect", substring = false).assertIsNotEnabled()
    }
}
