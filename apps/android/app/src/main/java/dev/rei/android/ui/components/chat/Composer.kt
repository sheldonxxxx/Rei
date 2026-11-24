package dev.rei.android.ui.components.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.ChatProfile
import dev.rei.android.data.SkillOption
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme

internal data class SlashMatch(val start: Int, val end: Int, val query: String)

internal fun parseSlashQuery(text: String, cursor: Int): SlashMatch? {
    var lead = 0
    while (lead < text.length && text[lead].isWhitespace()) lead++
    if (lead >= text.length || text[lead] != '/') return null
    var end = lead
    while (end < text.length && !text[end].isWhitespace()) end++
    if (cursor <= lead || cursor > end) return null
    return SlashMatch(start = lead, end = end, query = text.substring(lead + 1, end))
}

/** What the composer shows. Everything it needs is here, so it previews and tests without a view model. */
@Immutable
data class ComposerState(
    val draft: String = "",
    /** Bumped when the draft is replaced from outside (cleared by Send, restored after a failure), never while you type. */
    val draftEpoch: Int = 0,
    val attachments: List<AttachmentRef> = emptyList(),
    val skills: List<SkillOption> = emptyList(),
    val uploading: Boolean = false,
    /** A run is active: Send becomes Stop. */
    val running: Boolean = false,
    val stopping: Boolean = false,
    /** A send is on its way, or failed and waits for Retry. */
    val sending: Boolean = false,
    /** An approval waits: the field says so and Send waits too. */
    val waitingForAnswer: Boolean = false,
    val agentName: String = "",
    val modelLabel: String? = null,
    val effortLabel: String? = null,
    /** The chat's permission level, shown as a chip; null hides it. */
    val profile: ChatProfile? = null,
    /** Context use, 0–100, once the model has reported; shown only when it is getting full. */
    val contextPercent: Int? = null,
    val enabled: Boolean = true,
) {
    val hasContent: Boolean get() = draft.isNotBlank() || attachments.isNotEmpty()
    val canSend: Boolean get() = enabled && hasContent && !uploading && !sending && !waitingForAnswer
    val placeholder: String get() = if (waitingForAnswer) "Waiting for your answer" else if (agentName.isBlank()) "Message" else "Message $agentName"
}

/** Context use at which the meter appears. */
const val ContextMeterFrom = 70

/**
 * The composer: a rounded field on the card color with the control-border edge, a leading `+`, and a trailing circular
 * Send that becomes Stop while a run is active. Attachments show as removable chips above it; model, effort and context
 * use sit below as quiet chips. The field grows to six lines, then scrolls. The shell pads the chat by the keyboard, so it sits above it.
 */
@Composable
fun Composer(
    state: ComposerState,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: (AttachmentRef) -> Unit,
    onModel: () -> Unit,
    onEffort: () -> Unit,
    modifier: Modifier = Modifier,
    onPermissions: () -> Unit = {},
    onRemoveSkill: ((SkillOption) -> Unit)? = null,
    selectedSkills: List<SkillOption> = emptyList(),
    onSelectSkill: ((SkillOption) -> Unit)? = null,
    onLoadSkills: (() -> Unit)? = null,
    onJumpToApproval: (() -> Unit)? = null,
) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val textState = rememberTextFieldState(state.draft)
    val latestDraft by rememberUpdatedState(state.draft)
    val latestOnDraftChange by rememberUpdatedState(onDraftChange)

    // The field owns what you type; the draft is taken back from outside only when its epoch says it was replaced.
    LaunchedEffect(state.draftEpoch) {
        if (state.draft != textState.text.toString()) {
            textState.setTextAndPlaceCursorAtEnd(state.draft)
        }
    }
    LaunchedEffect(textState) {
        snapshotFlow { textState.text.toString() }.collect { typed ->
            if (typed != latestDraft) latestOnDraftChange(typed)
        }
    }

    val slashMatch by remember(state.enabled, state.waitingForAnswer) {
        derivedStateOf {
            if (!state.enabled || state.waitingForAnswer) null
            else parseSlashQuery(textState.text.toString(), textState.selection.end)
        }
    }
    LaunchedEffect(slashMatch != null) {
        if (slashMatch != null) onLoadSkills?.invoke()
    }

    val showCompact = slashMatch?.let { "compact".startsWith(it.query, ignoreCase = true) } == true
    val matchingSkills = remember(slashMatch, state.skills, selectedSkills) {
        val q = slashMatch?.query ?: return@remember emptyList()
        state.skills.filter { skill ->
            selectedSkills.none { it.id == skill.id } &&
                (q.isEmpty() || skill.name.contains(q, ignoreCase = true) || skill.description.contains(q, ignoreCase = true))
        }
    }

    Column(modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (state.waitingForAnswer) {
            Surface(
                onClick = { onJumpToApproval?.invoke() },
                enabled = onJumpToApproval != null,
                shape = ReiShapes.Pill,
                color = colors.tertiaryContainer,
                contentColor = colors.onTertiaryContainer,
                border = BorderStroke(1.dp, ReiTheme.colors.attentionBorder),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(ReiIcons.Shield, null, Modifier.size(18.dp))
                    Text("Approval waiting — Jump", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                    Icon(ReiIcons.Forward, null, Modifier.size(18.dp))
                }
            }
        }
        val match = slashMatch
        if (match != null && (showCompact || matchingSkills.isNotEmpty())) {
            Surface(
                shape = ReiShapes.Card,
                color = ReiTheme.colors.card,
                border = BorderStroke(1.dp, colors.outlineVariant),
                shadowElevation = 4.dp,
                modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp),
            ) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (showCompact) {
                        SlashPopupRow(
                            command = "/compact",
                            summary = "Summarize earlier context into fresh room",
                            onClick = {
                                textState.setTextAndPlaceCursorAtEnd("/compact ")
                                onDraftChange("/compact ")
                            },
                        )
                    }
                    matchingSkills.forEachIndexed { index, skill ->
                        if (showCompact || index > 0) HorizontalDivider(color = colors.outlineVariant)
                        SlashPopupRow(
                            command = "/${skill.name}",
                            summary = skill.description.ifBlank { null },
                            onClick = {
                                textState.edit {
                                    val eraseEnd = if (match.end < length && charAt(match.end) == ' ') match.end + 1 else match.end
                                    replace(match.start, eraseEnd, "")
                                }
                                onDraftChange(textState.text.toString())
                                onSelectSkill?.invoke(skill)
                            },
                        )
                    }
                }
            }
        }
        if (state.attachments.isNotEmpty() || selectedSkills.isNotEmpty() || state.uploading) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.attachments.forEach { file ->
                    RemovableChip(ReiIcons.File, file.name, "Remove ${file.name}", { onRemoveAttachment(file) })
                }
                selectedSkills.forEach { skill ->
                    RemovableChip(ReiIcons.Sparkle, "/${skill.name}", "Remove /${skill.name}", { onRemoveSkill?.invoke(skill) })
                }
                if (state.uploading) {
                    Text("Uploading…", Modifier.padding(horizontal = 8.dp, vertical = 8.dp), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                }
            }
        }
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = ReiTheme.colors.card,
            modifier = Modifier.fillMaxWidth().border(BorderStroke(1.dp, colors.outline), RoundedCornerShape(28.dp)),
        ) {
            Row(Modifier.padding(start = 4.dp, end = 4.dp), verticalAlignment = Alignment.Bottom) {
                ReiIconButton(ReiIcons.Plus, "Attach", onAttach, enabled = state.enabled && !state.uploading)
                Box(Modifier.weight(1f).padding(vertical = 14.dp), contentAlignment = Alignment.CenterStart) {
                    if (textState.text.isEmpty()) {
                        Text(
                            state.placeholder,
                            Modifier.clearAndSetSemantics {},
                            style = MaterialTheme.typography.bodyLarge,
                            color = colors.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    BasicTextField(
                        state = textState,
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Message" },
                        enabled = state.enabled && !state.waitingForAnswer,
                        lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 6),
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
                        cursorBrush = SolidColor(colors.primary),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    )
                }
                val send = !state.running
                Box(Modifier.heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                    SendButton(
                        running = state.running,
                        enabled = if (send) state.copy(draft = textState.text.toString()).canSend else !state.stopping,
                        onClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                            if (send) onSend() else onStop()
                        },
                    )
                }
            }
        }
        val chips = state.modelLabel != null || state.effortLabel != null || state.profile != null || (state.contextPercent ?: 0) >= ContextMeterFrom
        if (chips) {
            val chipScroll = rememberScrollState()
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    Modifier
                        .weight(1f)
                        .horizontalScroll(chipScroll)
                        .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                        .drawWithContent {
                            drawContent()
                            if (chipScroll.canScrollForward) {
                                val fadePx = 28.dp.toPx()
                                drawRect(
                                    brush = Brush.horizontalGradient(
                                        0f to Color.Transparent,
                                        1f to Color.Black,
                                        startX = (size.width - fadePx).coerceAtLeast(0f),
                                        endX = size.width,
                                    ),
                                    blendMode = BlendMode.DstOut,
                                )
                            }
                        },
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    state.modelLabel?.let { QuietChip("Model: $it", it, onModel) }
                    state.effortLabel?.let { QuietChip("Reasoning effort: $it", "$it effort", onEffort) }
                    state.profile?.let {
                        // YOLO is the level that needs attention, so it takes the ochre text color, as on the web.
                        QuietChip(
                            "Permissions: ${it.label}. Change", it.label, onPermissions,
                            tooltip = "Permissions for this chat",
                            tint = if (it == ChatProfile.Yolo) colors.onTertiaryContainer else colors.onSurfaceVariant,
                        )
                    }
                }
                state.contextPercent?.takeIf { it >= ContextMeterFrom }?.let { percent ->
                    Text(
                        "$percent% of context",
                        Modifier.semantics { contentDescription = "Context used: $percent percent" },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (percent >= 90) colors.error else colors.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun SlashPopupRow(command: String, summary: String?, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(ReiIcons.Sparkle, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(command, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (summary != null) {
                Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SendButton(running: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val label = if (running) "Stop reply" else "Send message"
    Box(
        Modifier
            .size(48.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = CircleShape,
            color = colors.primary,
            contentColor = colors.onPrimary,
            modifier = Modifier
                .size(40.dp)
                .alpha(if (enabled) 1f else 0.38f),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    if (running) ReiIcons.Stop else ReiIcons.Send,
                    contentDescription = null,
                    Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun RemovableChip(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, removeDescription: String, onRemove: () -> Unit) {
    Surface(
        shape = ReiShapes.Pill,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(icon, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(label, Modifier.widthIn(max = 200.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            ReiIconButton(ReiIcons.Close, removeDescription, onRemove, iconSize = 18.dp)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuietChip(
    description: String,
    label: String,
    onClick: () -> Unit,
    tooltip: String? = null,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    val chip: @Composable () -> Unit = {
        Row(
            Modifier
                .heightIn(min = 48.dp)
                .clickable(onClickLabel = "Change", role = Role.Button, onClick = onClick)
                .semantics(mergeDescendants = true) { contentDescription = description }
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = tint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
            Icon(ReiIcons.Chevron, null, Modifier.size(14.dp), tint = tint)
        }
    }
    if (tooltip == null) {
        chip()
    } else {
        // A long press names the chip, as it does for icon buttons.
        TooltipBox(
            positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
            tooltip = { PlainTooltip { Text(tooltip) } },
            state = rememberTooltipState(),
            content = chip,
        )
    }
}
