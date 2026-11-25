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
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.rei.android.R
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.ReiApproval
import dev.rei.android.ui.UiText
import dev.rei.android.ui.components.ReiPreviewSurface
import dev.rei.android.ui.components.ReiPreviews
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
    val resources = LocalResources.current
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
                error = (failure as? ReiApiException)?.message ?: resources.getString(R.string.approval_err_decide)
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
                    approvalHeading(item).asString(),
                    style = MaterialTheme.typography.titleSmall,
                    color = if (pending) colors.onTertiaryContainer else colors.onSurface,
                )
            }
            val who = agentName ?: stringResource(R.string.approval_agent_fallback)
            Text(
                if (pending) stringResource(R.string.approval_wants_to, who, item.summary) else item.summary,
                style = MaterialTheme.typography.bodyLarge,
                color = if (pending) colors.onTertiaryContainer else colors.onSurface,
            )
            val facts = listOfNotNull(
                item.destination?.takeIf { it.isNotBlank() }?.let { stringResource(R.string.approval_destination, it) },
                item.tool.takeIf { it.isNotBlank() },
            )
            if (facts.isNotEmpty()) {
                Text(
                    facts.joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (pending) colors.onTertiaryContainer else colors.onSurfaceVariant,
                )
            }
            if (pending && item.actionClass == "irreversible") {
                Text(stringResource(R.string.approval_irreversible), style = MaterialTheme.typography.bodyMedium, color = colors.error)
            }
            if (pending && item.taint.isNotEmpty()) {
                Text(
                    stringResource(R.string.approval_taint_warning),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onTertiaryContainer,
                )
            }
            if (pending && item.expiresAt > 0) {
                val deadline = remember(item.expiresAt) { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(item.expiresAt)) }
                Text(stringResource(R.string.approval_expires_at, deadline), style = MaterialTheme.typography.bodySmall, color = colors.onTertiaryContainer)
            }
            if (item.argsPreview.isNotBlank()) {
                TextButton(onClick = { showArgs = !showArgs }, contentPadding = ButtonDefaults.TextButtonContentPadding) {
                    Text(stringResource(if (showArgs) R.string.approval_hide_args else R.string.approval_show_args))
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
                    Text(stringResource(if (deciding == true) R.string.approval_allowing else R.string.approval_allow_once))
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (grantOptions(item).size > 1) {
                        OutlinedButton(
                            onClick = { options = true },
                            enabled = !busy,
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            border = BorderStroke(1.dp, colors.outline),
                        ) { Text(stringResource(R.string.approval_more_options)) }
                    }
                    TextButton(
                        onClick = { decide(false) },
                        enabled = !busy,
                        modifier = Modifier.heightIn(min = 48.dp),
                        colors = ButtonDefaults.textButtonColors(contentColor = colors.error),
                    ) { Text(stringResource(if (deciding == false) R.string.approval_denying else R.string.approval_deny)) }
                }
            } else {
                item.grantLength?.takeIf { item.status == "approved" }?.let { length ->
                    Text(decidedGrantLabel(length).asString(), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
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
    ReiSheet(onDismiss = onDismiss, title = stringResource(R.string.approval_sheet_title)) {
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
                        Text(grantLabel(option, item)?.asString().orEmpty(), style = MaterialTheme.typography.bodyLarge)
                        Text(
                            grantExplanation(option, agentName).asString(),
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
                    label = stringResource(R.string.approval_hours_label),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    enabled = !busy,
                    error = if (hoursChosen == null) stringResource(R.string.approval_hours_error) else null,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            Button(
                onClick = { onAllow(length, if (length == "hours") hoursChosen else null) },
                enabled = !busy && (length != "hours" || hoursChosen != null),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 12.dp).heightIn(min = 48.dp),
            ) { Text(stringResource(if (busy) R.string.approval_allowing else R.string.approval_allow)) }
        }
    }
}

/** The grants the server offers for this request, in its order; MCP tools only ever offer "once". */
internal fun grantOptions(item: ReiApproval): List<String> =
    if (item.connector == "mcp") listOf("once") else item.lengths.filter { it in GrantLabelRes }.ifEmpty { listOf("once") }

internal fun approvalHeading(item: ReiApproval): UiText {
    val baseRes = when (item.status) {
        "pending" -> R.string.approval_needed
        "approved" -> when (item.execution) {
            "ran" -> R.string.approval_allowed_ran
            "failed" -> R.string.approval_allowed_failed
            "needs_approval" -> R.string.approval_fresh_needed
            "interrupted" -> R.string.approval_interrupted
            else -> if (item.resumesTool) R.string.approval_allowed_resuming else R.string.approval_allowed
        }
        "denied" -> R.string.approval_denied
        "expired" -> R.string.approval_expired
        "cancelled" -> R.string.approval_cancelled
        else -> R.string.approval_default_title
    }
    return if (item.status == "pending") {
        UiText.Resource(baseRes)
    } else {
        UiText.Resource(R.string.approval_number_suffix, UiText.Resource(baseRes), item.number)
    }
}

private fun grantLabel(length: String, item: ReiApproval): UiText? = when {
    length == "session" && "web_session" in item.lengths -> UiText.Resource(R.string.approval_choice_destination)
    length == "session" && item.connector == "browser" && item.operation == "type" -> UiText.Resource(R.string.approval_choice_site)
    else -> GrantLabelRes[length]?.let { UiText.Resource(it) }
}

/** What a decided card says about the grant, in the web's words (`grantLabel` in `apps/web/src/lib/policy.ts`). */
internal fun decidedGrantLabel(length: String): UiText = UiText.Resource(
    when (length) {
        "once" -> R.string.approval_grant_once
        "session" -> R.string.approval_grant_session
        "web_session" -> R.string.approval_grant_web_session
        "agent" -> R.string.approval_grant_agent
        "hours" -> R.string.approval_grant_hours
        "always" -> R.string.approval_grant_always
        "trigger" -> R.string.approval_grant_trigger
        else -> R.string.approval_grant_fallback
    },
)

private fun grantExplanation(length: String, agent: String?): UiText = when (length) {
    "once" -> UiText.Resource(R.string.approval_explain_once)
    "session" -> UiText.Resource(R.string.approval_explain_session)
    "web_session" -> UiText.Resource(R.string.approval_explain_web_session)
    "agent" -> UiText.Resource(
        R.string.approval_explain_agent,
        agent?.let(UiText::Literal) ?: UiText.Resource(R.string.approval_this_agent),
    )
    "hours" -> UiText.Resource(R.string.approval_explain_hours)
    "always" -> UiText.Resource(R.string.approval_explain_always)
    "trigger" -> UiText.Resource(R.string.approval_explain_trigger)
    else -> UiText.Literal("")
}

private val GrantLabelRes = mapOf(
    "once" to R.string.approval_choice_once,
    "session" to R.string.approval_choice_session,
    "web_session" to R.string.approval_choice_web_session,
    "agent" to R.string.approval_choice_agent,
    "hours" to R.string.approval_choice_hours,
    "always" to R.string.approval_choice_always,
    "trigger" to R.string.approval_choice_trigger,
)

@ReiPreviews
@Composable
private fun ApprovalCardPreview() = ReiPreviewSurface {
    val sample = ReiApproval(
        id = "a1",
        number = 1,
        sessionId = "s1",
        sessionTitle = "Weekly review",
        tool = "bash",
        connector = "",
        operation = "run",
        actionClass = "execute",
        destination = null,
        summary = "Run workspace cleanup script",
        argsPreview = "{\"cmd\":\"rm -rf build/tmp\"}",
        lengths = listOf("once", "session", "always"),
        status = "pending",
        taint = emptyList(),
        expiresAt = 0L,
        grantLength = null,
        grantExpiresAt = null,
        resumesTool = true,
        execution = null,
    )
    ApprovalCard(
        approval = sample,
        onDecide = { _, _, _ -> sample },
        agentName = "Rei",
    )
}
