package dev.rei.android.feature.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext

/** Launchers for the two ways to bring a file from the device. Each upload is attached to the draft when it finishes. */
class AttachmentPickers(val deviceFiles: () -> Unit, val photos: () -> Unit)

@Composable
fun rememberAttachmentPickers(sessionId: String, chat: ChatViewModel): AttachmentPickers {
    val provider = LocalContext.current.contentResolver
    val currentChat = rememberUpdatedState(chat)
    val currentSession = rememberUpdatedState(sessionId)

    fun upload(uri: Uri?) {
        if (uri != null) currentChat.value.uploadAttachment(provider, currentSession.value, uri)
    }

    val pickDocument = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { upload(it) }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { upload(it) }
    return AttachmentPickers(
        deviceFiles = { pickDocument.launch(arrayOf("*/*")) },
        photos = { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
    )
}
