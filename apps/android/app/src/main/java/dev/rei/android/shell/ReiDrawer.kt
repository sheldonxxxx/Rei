package dev.rei.android.shell

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.BuildConfig
import dev.rei.android.data.ChatAgent
import dev.rei.android.data.Session
import dev.rei.android.ui.components.AgentAvatar
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiWordmark
import dev.rei.android.ui.components.SectionHeader
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.tabular

/** What the drawer can ask for. The shell wires these to navigation and to [ShellViewModel]. */
class DrawerActions(
    val onSearch: () -> Unit,
    val onNewChat: () -> Unit,
    val onNavigate: (Destination) -> Unit,
    val onSelectAgent: (ChatAgent) -> Unit,
    val onNewAgent: () -> Unit,
    val onOpenChat: (String) -> Unit,
    val onChatActions: (Session) -> Unit,
    val onShowTriggers: (Boolean) -> Unit,
    val onLoadMore: () -> Unit,
)

/**
 * The drawer, in the order and words of the web sidebar: header (portrait, "Rei", search), the New chat pill, Library,
 * Knowledge, Background Activity (with its badge), Agents, Chats grouped by date, and the Settings footer with the
 * version. The selected agent and the current destination get the selected background and a visible outline.
 */
@Composable
fun ReiDrawerContent(
    state: DrawerUiState,
    current: Destination,
    actions: DrawerActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp)) {
            item(key = "header") {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ReiWordmark(Modifier.weight(1f))
                    ReiIconButton(ReiIcons.Search, "Search chats", actions.onSearch)
                }
            }
            item(key = "new-chat") {
                FilledTonalButton(
                    onClick = actions.onNewChat,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(bottom = 4.dp),
                    shape = ReiShapes.Pill,
                ) {
                    Icon(ReiIcons.Compose, contentDescription = null, modifier = Modifier.size(20.dp))
                    Text("New chat", Modifier.padding(start = 10.dp).weight(1f), style = MaterialTheme.typography.labelLarge)
                }
            }
            item(key = "nav") {
                Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    NavRow("Library", ReiIcons.Library, current == Destination.Library) { actions.onNavigate(Destination.Library) }
                    NavRow("Knowledge", ReiIcons.Knowledge, current == Destination.Knowledge) { actions.onNavigate(Destination.Knowledge) }
                    NavRow("Background Activity", ReiIcons.Activity, current == Destination.Activity, badge = state.attentionCount) {
                        actions.onNavigate(Destination.Activity)
                    }
                }
            }
            if (state.agents.isNotEmpty()) {
                item(key = "agents-head") {
                    SectionHeader("Agents", action = { ReiIconButton(ReiIcons.Plus, "New agent", actions.onNewAgent) })
                }
                items(state.agents, key = { "agent-${it.id}" }) { agent ->
                    AgentRow(
                        agent = agent,
                        selected = agent.id == state.selectedAgentId,
                        attention = state.attentionSessionIds.contains(agent.homeSessionId),
                        onClick = { actions.onSelectAgent(agent) },
                    )
                }
            }
            item(key = "chats-head") {
                var menu by remember { mutableStateOf(false) }
                SectionHeader(
                    "Chats",
                    Modifier.padding(top = 4.dp),
                    action = {
                        Box {
                            ReiIconButton(ReiIcons.Filter, "Filter chats", { menu = true }, toggled = if (state.showTriggers) true else null)
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text(if (state.showTriggers) "Hide trigger sessions" else "Show trigger sessions") },
                                    leadingIcon = { Icon(ReiIcons.Clock, contentDescription = null) },
                                    onClick = { menu = false; actions.onShowTriggers(!state.showTriggers) },
                                )
                            }
                        }
                    },
                )
            }
            if (state.loaded && state.groups.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "No chats yet. Start a chat to begin.",
                        Modifier.padding(horizontal = 12.dp, vertical = 16.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            state.groups.forEach { group ->
                item(key = "group-${group.label}") { SectionHeader(group.label) }
                items(group.sessions, key = { "chat-${it.id}" }) { session ->
                    ChatRow(
                        session = session,
                        selected = session.id == state.openSessionId && current == Destination.Chat,
                        attention = state.attentionSessionIds.contains(session.id) || session.pendingApprovals > 0,
                        onClick = { actions.onOpenChat(session.id) },
                        onLongClick = { actions.onChatActions(session) },
                    )
                }
            }
            if (state.hasMore) {
                item(key = "more") {
                    LaunchedEffect(state.groups.sumOf { it.sessions.size }) { actions.onLoadMore() }
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            NavRow("Settings", ReiIcons.Settings, current == Destination.Settings) { actions.onNavigate(Destination.Settings) }
            Text(
                "Rei ${BuildConfig.VERSION_NAME}",
                Modifier.padding(start = 12.dp, top = 4.dp, bottom = 4.dp),
                style = MaterialTheme.typography.bodySmall.tabular(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun NavRow(label: String, icon: ImageVector, selected: Boolean, badge: Int = 0, onClick: () -> Unit) {
    SelectableRow(selected, onClick, Modifier.heightIn(min = 48.dp)) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp))
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (badge > 0) {
            Surface(shape = CircleShape, color = MaterialTheme.colorScheme.onTertiaryContainer, contentColor = MaterialTheme.colorScheme.background) {
                Text(
                    badge.toString(),
                    Modifier.heightIn(min = 20.dp).padding(horizontal = 7.dp).semantics { contentDescription = if (badge == 1) "1 needs you" else "$badge need you" },
                    style = MaterialTheme.typography.labelMedium.tabular().copy(fontWeight = FontWeight.Bold),
                )
            }
        }
    }
}

@Composable
private fun AgentRow(agent: ChatAgent, selected: Boolean, attention: Boolean, onClick: () -> Unit) {
    SelectableRow(selected, onClick, Modifier.heightIn(min = 48.dp)) {
        AgentAvatar(agent.avatar, size = 28.dp)
        Text(
            agent.name,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (attention) AttentionDot()
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(session: Session, selected: Boolean, attention: Boolean, onClick: () -> Unit, onLongClick: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val unread = session.unread > 0 && !selected
    val title = session.title.ifBlank { "Untitled chat" }
    SelectableRow(
        selected = selected,
        onClick = onClick,
        modifier = Modifier
            .heightIn(min = 48.dp)
            .semantics {
                stateDescription = listOfNotNull(
                    if (attention) "Approval needed" else null,
                    if (unread) "Unread" else null,
                ).joinToString(", ")
            },
        onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); onLongClick() },
    ) {
        Text(
            title,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (unread) Dot(MaterialTheme.colorScheme.primary)
        if (attention) AttentionDot()
    }
}

@Composable
private fun AttentionDot() = Dot(MaterialTheme.colorScheme.tertiary)

@Composable
private fun Dot(color: androidx.compose.ui.graphics.Color) {
    Box(Modifier.size(8.dp).background(color, CircleShape))
}

/** A drawer row: the selected one gets the selected background and a visible outline. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SelectableRow(
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit,
) {
    Surface(
        modifier = modifier.fillMaxWidth().semantics { this.selected = selected },
        shape = ReiShapes.Pill,
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent,
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = if (selected) BorderStroke(1.dp, MaterialTheme.colorScheme.outline) else null,
    ) {
        Row(
            Modifier
                .combinedClickable(role = Role.Button, onClick = onClick, onLongClick = onLongClick)
                .padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}
