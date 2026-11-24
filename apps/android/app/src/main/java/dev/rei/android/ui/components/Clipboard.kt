package dev.rei.android.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast

/**
 * Puts [text] on the clipboard. Android 13 and later confirm a copy themselves; before that this shows the same short
 * confirmation, so "Copied" never depends on the OS version.
 */
fun copyToClipboard(context: Context, label: String, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}
