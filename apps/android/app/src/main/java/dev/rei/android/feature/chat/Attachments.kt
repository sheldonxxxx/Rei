package dev.rei.android.feature.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.uploadBody
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Launchers for the two ways to bring a file from the device. Each upload is attached to the draft when it finishes. */
class AttachmentPickers(val deviceFiles: () -> Unit, val photos: () -> Unit)

@Composable
fun rememberAttachmentPickers(api: ReiApi, sessionId: String, chat: ChatViewModel): AttachmentPickers {
    val scope = rememberCoroutineScope()
    val provider = LocalContext.current.contentResolver
    val currentChat = rememberUpdatedState(chat)

    fun upload(uri: Uri?) {
        if (uri == null) return
        scope.launch {
            val vm = currentChat.value
            vm.setUploading(true)
            try {
                val (name, body) = withContext(Dispatchers.IO) { provider.uploadBody(uri) }
                vm.addAttachment(api.uploadAttachment(sessionId, name, body))
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                vm.uploadFailed((failure as? ReiApiException)?.message ?: "Couldn’t attach that file. Try again.")
            } finally {
                vm.setUploading(false)
            }
        }
    }

    val pickDocument = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { upload(it) }
    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { upload(it) }
    return AttachmentPickers(
        deviceFiles = { pickDocument.launch(arrayOf("*/*")) },
        photos = { pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
    )
}
