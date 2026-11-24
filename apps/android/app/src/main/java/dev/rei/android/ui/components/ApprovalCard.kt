package dev.rei.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.ReiApproval
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiEnter
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.ReiTheme
import dev.rei.android.ui.theme.arrive
import dev.rei.android.ui.theme.mono
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

/**
 * The one approval card, shared by the transcript and Background Activity. Ochre edge on the attention-soft color, heading
 * "Approval needed", and a live region so TalkBack announces it. While it waits: "Allow once" (filled, full width), "More
 * options" (a sheet that says what a broader grant permits) and "Deny". Once decided it settles into a quiet record.
 *
 * [onDecide] performs the decision and returns the approval as the server now has it; the card shows that answer until the
 * stream carries the same.
 */
@Composable
fun ApprovalCard(
    approval: ReiApproval,
    onDecide: suspend (approve: Boolean, length: String, hours: Int?) -> ReiApproval,
    modifier: Modifier = Modifier,
    agentName: String? = null,
    onDecided: (ReiApproval) -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var complete by remember(approval.id) { mutableStateOf<ReiApproval?>(null) }
    val item = if (approval.status == "pending") complete ?: approval else approval
    val pending = item.status == "pending"
    var options by remember(approval.id) { mutableStateOf(false) }
    var showArgs by remember(approval.id) { mutableStateOf(false) }
    var deciding by remember(approval.id) { mutableStateOf<Boolean?>(null) }
    var error by remember(approval.id) { mutableStateOf<String?>(null) }
    val busy = deciding != null

    fun decide(approve: Boolean, length: String = "once", hours: Int? = null) {
        deciding = approve
        error = null
        haptics.performHapticFeedback(if (approve) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
        scope.launch {
            try {
                val answer = onDecide(approve, length, hours)
                complete = answer
                options = false
                onDecided(answer)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                error = (failure as? ReiApiException)?.message ?: "Could not decide this request. Try again."
            } finally {
                deciding = null
            }
        }
    }

    val colors = MaterialTheme.colorScheme
    Surface(
        modifier
            .fillMaxWidth()
            .then(if (pending) Modifier.arrive(ReiEnter.Card) else Modifier)
            .semantics { if (pending) liveRegion = LiveRegionMode.Polite },
        shape = ReiShapes.Card,
        color = if (pending) colors.tertiaryContainer else ReiTheme.colors.card,
        border = BorderStroke(1.dp, if (pending) ReiTheme.colors.attentionBorder else colors.outlineVariant),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    ReiIcons.Shield,
                    contentDescription = null,
                    Modifier.size(20.dp),
                    tint = if (pending) colors.onTertiaryContainer else colors.onSurfaceVariant,
                )
                Text(
                    approvalHeading(item),
                    style = MaterialTheme.typography.titleSmall,
                    color = if (pending) colors.onTertiaryContainer else colors.onSurface,
                )
            }
            val who = agentName ?: "An agent"
            Text(
                if (pending) "$who wants to: ${item.summary}" else item.summary,
                style = MaterialTheme.typography.bodyLarge,
                color = if (pending) colors.onTertiaryContainer else colors.onSurface,
            )
            val facts = listOfNotNull(item.destination?.takeIf { it.isNotBlank() }?.let { "To $it" }, item.tool.takeIf { it.isNotBlank() })
            if (facts.isNotEmpty()) {
                Text(
                    facts.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (pending) colors.onTertiaryContainer else colors.onSurfaceVariant,
                )
            }
            if (pending && item.actionClass == "irreversible") {
                Text("This can’t be undone.", style = MaterialTheme.typography.bodyMedium, color = colors.error)
            }
            if (pending && item.taint.isNotEmpty()) {
                Text(
                    "This follows content from an outside source. Check the details before you allow it.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onTertiaryContainer,
                )
            }
            if (pending && item.expiresAt > 0) {
                val deadline = remember(item.expiresAt) { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(item.expiresAt)) }
                Text("Expires at $deadline", style = MaterialTheme.typography.bodySmall, color = colors.onTertiaryContainer)
            }
            if (item.argsPreview.isNotBlank()) {
                TextButton(onClick = { showArgs = !showArgs }, contentPadding = ButtonDefaults.TextButtonContentPadding) {
                    Text(if (showArgs) "Hide request details" else "Show request details")
                }
                if (showArgs) {
                    Surface(
                        shape = ReiShapes.Inset,
                        color = colors.surfaceContainerLow,
                        border = BorderStroke(1.dp, colors.outlineVariant),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        SelectionContainer {
                            Text(
                                item.argsPreview,
                                Modifier.padding(12.dp),
                                style = MaterialTheme.typography.bodySmall.mono(),
                                color = colors.onSurface,
                            )
                        }
                    }
                }
            }
            if (pending) {
                Button(onClick = { decide(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (deciding == true) "Allowing…" else "Allow once")
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (grantOptions(item).size > 1) {
                        OutlinedButton(
                            onClick = { options = true },
                            enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            border = BorderStroke(1.dp, colors.outline),
                        ) { Text("More options") }
                    }
                    TextButton(
                        onClick = { decide(false) },
                        enabled = !busy,
                        modifier = Modifier.heightIn(min = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.error),
                    ) { Text(if (deciding == false) "Denying…" else "Deny") }
                }
            } else {
                item.grantLength?.takeIf { item.status == "approved" }?.let { length ->
                    Text(decidedGrantLabel(length), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.error) }
        }
    }
    if (options) GrantSheet(item, agentName, busy, onDismiss = { options = false }) { length, hours -> decide(true, length, hours) }
}

/** For callers that still hold an [ReiApi] (Background Activity until it is rebuilt). */
@Composable
fun ApprovalCard(api: ReiApi, approval: ReiApproval, onDecided: (ReiApproval) -> Unit = {}) {
    ApprovalCard(
        approval = approval,
        onDecide = { approve, length, hours -> api.decideApproval(approval.id, approve, length, hours) },
        onDecided = onDecided,
    )
}

@Composable
private fun GrantSheet(
    item: ReiApproval,
    agentName: String?,
    busy: Boolean,
    onDismiss: () -> Unit,
    onAllow: (length: String, hours: Int?) -> Unit,
) {
    val options = grantOptions(item)
    var length by remember(item.id) { mutableStateOf("once") }
    var hours by remember(item.id) { mutableStateOf("1") }
    val hoursChosen = hours.toIntOrNull()?.takeIf { it in 1..168 }
    ReiSheet(onDismiss = onDismiss, title = "Allow this and similar requests") {
        Column(Modifier.padding(horizontal = 12.dp).verticalScroll(rememberScrollState()).imePadding()) {
            options.forEach { option ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 56.dp)
                        .selectable(selected = length == option, role = Role.RadioButton, onClick = { length = option })
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    RadioButton(selected = length == option, onClick = null)
                    Column {
                        Text(grantLabel(option, item).orEmpty(), style = MaterialTheme.typography.bodyLarge)
                        Text(
                            grantExplanation(option, agentName),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (length == "hours") {
                ReiTextField(
                    value = hours,
                    onValueChange = { hours = it.filter(Char::isDigit).take(3) },
                    label = "Hours (1–168)",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    enabled = !busy,
                    error = if (hoursChosen == null) "Enter whole hours between 1 and 168." else null,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            Button(
                onClick = { onAllow(length, if (length == "hours") hoursChosen else null) },
                enabled = !busy && (length != "hours" || hoursChosen != null),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp).heightIn(min = 48.dp),
            ) { Text(if (busy) "Allowing…" else "Allow") }
        }
    }
}

/** The grants the server offers for this request, in its order; MCP tools only ever offer "once". */
internal fun grantOptions(item: ReiApproval): List<String> =
    if (item.connector == "mcp") listOf("once") else item.lengths.filter { it in GrantLabels }.ifEmpty { listOf("once") }

internal fun approvalHeading(item: ReiApproval): String {
    val base = when (item.status) {
        "pending" -> "Approval needed"
        "approved" -> when (item.execution) {
            "ran" -> "Allowed · Ran"
            "failed" -> "Allowed · Failed"
            "needs_approval" -> "Fresh approval needed"
            "interrupted" -> "Interrupted · May have run"
            else -> if (item.resumesTool) "Allowed · Resuming" else "Allowed"
        }
        "denied" -> "Denied"
        "expired" -> "Expired"
        "cancelled" -> "Cancelled"
        else -> "Approval"
    }
    return if (item.status == "pending") base else "$base · #${item.number}"
}

private fun grantLabel(length: String, item: ReiApproval): String? = when {
    length == "session" && "web_session" in item.lengths -> "This destination for this chat"
    length == "session" && item.connector == "browser" && item.operation == "type" -> "This site for this chat"
    else -> GrantLabels[length]
}

/** What a decided card says about the grant, in the web's words (`grantLabel` in `apps/web/src/lib/policy.ts`). */
internal fun decidedGrantLabel(length: String): String = when (length) {
    "once" -> "Approved once"
    "session" -> "Approved for this chat"
    "web_session" -> "All web approved for this chat"
    "agent" -> "Approved for this agent"
    "hours" -> "Approved for a set time"
    "always" -> "Always allowed"
    "trigger" -> "Approved for this trigger"
    else -> "Approved"
}

private fun grantExplanation(length: String, agent: String?): String = when (length) {
    "once" -> "Only this request. Rei asks again next time."
    "session" -> "Rei won’t ask again for this in this chat."
    "web_session" -> "Allow public web searches and page fetches in this chat. Queries and URLs may contain chat information."
    "agent" -> "Rei won’t ask again for this in any chat with ${agent ?: "this agent"}."
    "hours" -> "Rei won’t ask again for this until the time is up."
    "always" -> "Rei won’t ask again for this, anywhere. You can undo it in Settings."
    "trigger" -> "Rei won’t ask again for this when this trigger runs."
    else -> ""
}

private val GrantLabels = mapOf(
    "once" to "Just this once",
    "session" to "For this chat",
    "web_session" to "All web for this chat",
    "agent" to "For this agent",
    "hours" to "For a number of hours",
    "always" to "Always",
    "trigger" to "For this trigger",
)
