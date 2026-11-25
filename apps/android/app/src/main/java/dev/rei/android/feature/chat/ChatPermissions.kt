package dev.rei.android.feature.chat

import dev.rei.android.data.ChatProfile
import dev.rei.android.ui.UiText

/**
 * The chat's permission level while it is being changed. The new level shows at once; if Rei refuses or cannot be
 * reached it goes back and says why. A stale stream update that arrives meanwhile cannot undo the choice, because
 * [ChatUiState.profileChoice] wins until the save settles.
 */
internal fun ChatUiState.startProfileChange(next: ChatProfile): ChatUiState =
    copy(profileChoice = next, savingProfile = true, profileError = null)

/** Rei saved it: the level is now part of the session itself, so the next stream update agrees. */
internal fun ChatUiState.finishProfileChange(saved: ChatProfile): ChatUiState = copy(
    profileChoice = null,
    savingProfile = false,
    session = session?.copy(profile = saved),
    detail = detail?.let { it.copy(session = it.session.copy(profile = saved)) },
)

/** Rei did not save it: back to what it was, with a plain-language reason. */
internal fun ChatUiState.failProfileChange(message: UiText): ChatUiState =
    copy(profileChoice = null, savingProfile = false, profileError = message)

internal fun ChatUiState.failProfileChange(message: String): ChatUiState =
    failProfileChange(UiText.Literal(message))
