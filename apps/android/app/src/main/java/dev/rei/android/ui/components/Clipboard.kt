package dev.rei.android.ui.components

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.widget.Toast
import dev.rei.android.R

/**
 * Puts [text] on the clipboard. Android 13 and later confirm a copy themselves; before that this shows the same short
 * confirmation, so "Copied" never depends on the OS version. A [sensitive] copy (a secret key, a recovery code) is flagged
 * so that Android 13+ hides it from the clipboard preview and keyboard suggestions.
 */
fun copyToClipboard(context: Context, label: String, text: String, sensitive: Boolean = false) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText(label, text)
    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    }
    clipboard.setPrimaryClip(clip)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, R.string.common_copied, Toast.LENGTH_SHORT).show()
}
