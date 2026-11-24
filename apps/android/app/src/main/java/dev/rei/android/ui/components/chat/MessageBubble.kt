package dev.rei.android.ui.components.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.Message
import dev.rei.android.data.MessagePart
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.LocalMotionScale
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.arrive

/** Your message: right-aligned in `surfaceContainerHigh`, up to 85 % of the width. No arrival animation: you just wrote it. */
@Composable
fun UserBubble(
    message: Message,
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
    highlighted: Boolean = false,
    onOpenAttachment: (AttachmentRef) -> Unit = {},
    onShowVersions: () -> Unit = {},
) {
    val haptics = LocalHapticFeedback.current
    val flash = rememberFlash(highlighted)
    val colors = MaterialTheme.colorScheme
    val optionsLabel = stringResource(R.string.chat_msg_options)
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BubbleBox(Alignment.End, 0.85f) {
            Surface(
                shape = ReiShapes.BubbleUser,
                color = lerp(colors.surfaceContainerHigh, colors.tertiaryContainer, flash),
                contentColor = colors.onSurface,
                modifier = Modifier
                    .semantics {
                        customActions = listOf(CustomAccessibilityAction(optionsLabel) { onLongPress(); true })
                    }
                    .pointerInput(onLongPress) {
                        detectTapGestures(onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress()
                        })
                    },
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (message.text.isNotBlank()) Text(message.text, style = MaterialTheme.typography.bodyLarge)
                    message.attachments.forEach { label ->
                        val file = message.fileReferences.firstOrNull { it.name == label }
                        AttachmentLabel(label, if (file != null) ({ onOpenAttachment(file) }) else null)
                    }
                }
            }
        }
        message.versions?.let { versions ->
            TextButton(onClick = onShowVersions, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.chat_msg_version_of, versions.index, versions.count), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
            }
        }
        if (message.status == "aborted") {
            Text(stringResource(R.string.chat_msg_cancelled), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, modifier = Modifier.padding(end = 4.dp))
        } else if (message.status == "pending") {
            Text(stringResource(R.string.chat_msg_queued), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, modifier = Modifier.padding(end = 4.dp))
        }
    }
}

/** A message that has not reached the transcript: sending, or failed with Retry and Discard under it. */
@Composable
fun PendingBubble(
    text: String,
    attachments: List<AttachmentRef>,
    failed: Boolean,
    error: String?,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BubbleBox(Alignment.End, 0.85f) {
            Surface(shape = ReiShapes.BubbleUser, color = colors.surfaceContainerHigh) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (text.isNotBlank()) Text(text, style = MaterialTheme.typography.bodyLarge)
                    attachments.forEach { AttachmentLabel(it.name, null) }
                }
            }
        }
        if (failed) {
            Text(
                error ?: stringResource(R.string.chat_msg_not_sent),
                Modifier.padding(end = 4.dp).semantics { liveRegion = LiveRegionMode.Assertive },
                style = MaterialTheme.typography.bodySmall,
                color = colors.error,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = onDiscard, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.common_discard)) }
                TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.common_retry)) }
            }
        } else {
            Text(stringResource(R.string.chat_msg_sending), Modifier.padding(end = 4.dp), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        }
    }
}

/** The assistant's quiet icon row under a finished reply: Copy (with brief check) and Inspect; Fork/Retry live in the message sheet. */
@Immutable
data class ReplyActions(
    val onCopy: () -> Unit,
    val onInspect: (() -> Unit)? = null,
)

/**
 * The assistant's reply: left-aligned in `surfaceContainerLow`, up to 92 % of the width, Markdown inside. Text appears in
 * place while [streaming], with a caret. Content arrives with `rise`; [actions] shows once the reply is finished.
 */
@Composable
fun AssistantBubble(
    message: Message?,
    text: String,
    api: ReiApi?,
    sessionId: String,
    agentName: String,
    onLongPress: () -> Unit,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    highlighted: Boolean = false,
    actions: ReplyActions? = null,
    onContinue: (() -> Unit)? = null,
    showDetails: Boolean = false,
) {
    val haptics = LocalHapticFeedback.current
    val flash = rememberFlash(highlighted)
    val colors = MaterialTheme.colorScheme
    val failed = message?.status == "failed"
    val parts = message?.parts.orEmpty()
    val hasContent = text.isNotBlank() || parts.isNotEmpty()
    val optionsLabel = stringResource(R.string.chat_msg_options)
    val copyLabel = stringResource(R.string.common_copy)
    val inspectLabel = stringResource(R.string.chat_msg_inspect)
    Column(modifier.fillMaxWidth().arrive(ReiEnter.Rise), horizontalAlignment = Alignment.Start, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (hasContent) BubbleBox(Alignment.Start, 0.92f) {
            Surface(
                shape = ReiShapes.BubbleAssistant,
                color = lerp(colors.surfaceContainerLow, colors.tertiaryContainer, flash),
                contentColor = colors.onSurface,
                modifier = Modifier
                    .semantics {
                        customActions = buildList {
                            add(CustomAccessibilityAction(optionsLabel) { onLongPress(); true })
                            if (!streaming && actions != null) {
                                add(CustomAccessibilityAction(copyLabel) { actions.onCopy(); true })
                                actions.onInspect?.let { inspect ->
                                    add(CustomAccessibilityAction(inspectLabel) { inspect(); true })
                                }
                            }
                        }
                    }
                    .pointerInput(onLongPress) {
                        detectTapGestures(onLongPress = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress()
                        })
                    },
            ) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (parts.isEmpty()) {
                        if (text.isNotBlank()) ReiMarkdown(text, api, caret = streaming)
                    } else {
                        parts.forEachIndexed { index, part ->
                            when (part) {
                                is MessagePart.Text -> if (part.text.isNotBlank()) ReiMarkdown(part.text, api, caret = streaming && index == parts.lastIndex)
                                is MessagePart.Surface -> if (api != null) InlineSurface(api, sessionId, part.value, detail = showDetails)
                            }
                        }
                    }
                }
            }
        }
        if (failed) {
            StatusBanner(
                message?.error ?: stringResource(R.string.chat_msg_reply_failed),
                Modifier.padding(top = 4.dp).widthIn(max = 640.dp),
                kind = StatusKind.Error,
                actionLabel = if (onContinue != null) stringResource(R.string.chat_msg_continue) else null,
                onAction = onContinue,
            )
        } else if (message?.status == "cancelled") {
            Text(stringResource(R.string.chat_msg_stopped), Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        }
        if (actions != null && hasContent && !streaming) ReplyActionRow(actions)
    }
}

@Composable
private fun ReplyActionRow(actions: ReplyActions) {
    val quiet = MaterialTheme.colorScheme.onSurfaceVariant
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(1500)
            copied = false
        }
    }
    Row(Modifier.padding(start = 0.dp), horizontalArrangement = Arrangement.spacedBy(0.dp)) {
        ReiIconButton(
            icon = if (copied) ReiIcons.Check else ReiIcons.Copy,
            contentDescription = stringResource(if (copied) R.string.common_copied else R.string.common_copy),
            onClick = {
                actions.onCopy()
                copied = true
            },
            tint = if (copied) MaterialTheme.colorScheme.primary else quiet,
            iconSize = 16.dp,
        )
        actions.onInspect?.let { ReiIconButton(ReiIcons.Eye, stringResource(R.string.chat_msg_inspect), it, tint = quiet, iconSize = 16.dp) }
    }
}

/** A system line in the transcript: "Earlier context was summarized." and "New context". */
@Composable
fun NoticeLine(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.fillMaxWidth().padding(vertical = 8.dp),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
    )
}

/** Shown while a run is working and nothing has streamed yet. */
@Composable
fun ThinkingLine(agentName: String, modifier: Modifier = Modifier) {
    Text(
        stringResource(R.string.chat_msg_thinking, agentName),
        modifier.padding(horizontal = 4.dp, vertical = 8.dp).arrive(ReiEnter.Fade).semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun AttachmentLabel(label: String, onClick: (() -> Unit)?) {
    Surface(
        onClick = { onClick?.invoke() },
        enabled = onClick != null,
        shape = ReiShapes.Pill,
        color = ReiTheme.colors.card,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            androidx.compose.material3.Icon(ReiIcons.File, null, Modifier.padding(0.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
        }
    }
}

/** Aligns a bubble and caps it at [fraction] of the container width, and at the reading column on wide screens. */
@Composable
private fun BubbleBox(alignment: Alignment.Horizontal, fraction: Float, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val width = with(density) { LocalWindowInfo.current.containerSize.width.toDp() }
    Box(Modifier.fillMaxWidth(), contentAlignment = if (alignment == Alignment.End) Alignment.CenterEnd else Alignment.CenterStart) {
        Box(Modifier.widthIn(max = minOf(width * fraction, 680.dp))) { content() }
    }
}

/** 1 while a bubble is the target of a notification or search hit, easing back to 0. */
@Composable
private fun rememberFlash(highlighted: Boolean): Float {
    val scale = LocalMotionScale.current
    val flash by animateFloatAsState(
        if (highlighted) 1f else 0f,
        tween(if (scale <= 0f) 0 else if (highlighted) 150 else 900),
        label = "flash",
    )
    return flash
}

@ReiPreviews
@Composable
private fun MessageBubblePreview() = ReiPreviewSurface {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        UserBubble(
            message = Message(id = "u1", role = "user", text = "Summarize the Q3 release notes.", status = "complete"),
            onLongPress = {},
        )
        AssistantBubble(
            message = Message(id = "a1", role = "assistant", text = "Here are the **three main changes** shipped in Q3.", status = "complete"),
            text = "Here are the **three main changes** shipped in Q3.",
            api = null,
            sessionId = "s1",
            agentName = "Rei",
            onLongPress = {},
            actions = ReplyActions(onCopy = {}, onInspect = {}),
        )
    }
}
