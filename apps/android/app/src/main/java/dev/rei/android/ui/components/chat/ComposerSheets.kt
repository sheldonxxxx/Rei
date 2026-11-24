package dev.rei.android.ui.components.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.rei.android.data.AttachmentRef
import dev.rei.android.data.ChatProfile
import dev.rei.android.data.ModelCatalog
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.SkillOption
import dev.rei.android.ui.components.PillField
import dev.rei.android.ui.components.ReiSheet
import dev.rei.android.ui.components.SettingsChevron
import dev.rei.android.ui.components.SettingsRow
import dev.rei.android.ui.icons.ReiIcons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** The one attachment sheet behind the composer's `+`: device files, photos, the Library and slash commands. */
@Composable
fun AttachmentSheet(
    onDismiss: () -> Unit,
    onDeviceFiles: () -> Unit,
    onPhotos: () -> Unit,
    onLibrary: () -> Unit,
    onSlashCommands: () -> Unit,
) {
    ReiSheet(onDismiss = onDismiss, title = "Add to your message") {
        SettingsRow("Device files", icon = ReiIcons.File, onClick = onDeviceFiles)
        SettingsRow("Photos", icon = ReiIcons.Image, onClick = onPhotos)
        SettingsRow("Library", icon = ReiIcons.Library, onClick = onLibrary)
        SettingsRow("Slash commands", icon = ReiIcons.Terminal, onClick = onSlashCommands, summary = "Run one of the agent’s skills")
    }
}

/** Files already in the Library, searchable, attached by reference (no upload). */
@Composable
fun LibraryAttachmentSheet(api: ReiApi, onDismiss: () -> Unit, onSelect: (AttachmentRef) -> Unit) {
    var query by remember { mutableStateOf("") }
    var files by remember { mutableStateOf(emptyList<AttachmentRef>()) }
    var next by remember { mutableStateOf<String?>(null) }
    var paging by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(query, reload, paging) {
        loading = true
        error = null
        if (!paging) {
            files = emptyList()
            next = null
            delay(200)
        }
        try {
            val page = api.libraryFiles(query, next)
            files = (files + page.files).distinctBy { it.versionId }
            next = page.nextCursor
        } catch (failure: CancellationException) {
            throw failure
        } catch (failure: Exception) {
            error = (failure as? ReiApiException)?.message ?: "Couldn’t load the Library."
        } finally {
            loading = false
        }
    }

    ReiSheet(onDismiss = onDismiss, title = "Attach from the Library") {
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PillField(query, { query = it; paging = false }, "Search files", description = "Search files", leadingIcon = ReiIcons.Search)
            LazyColumn(Modifier.heightIn(max = 360.dp)) {
                items(files, key = { it.versionId }) { file ->
                    SettingsRow(file.name, icon = ReiIcons.File, onClick = { onSelect(file) })
                }
                item {
                    when {
                        loading -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
                        error != null -> Column(Modifier.padding(8.dp)) {
                            Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { reload++ }) { Text("Try again") }
                        }
                        files.isEmpty() -> Text("No files found.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        next != null -> TextButton(onClick = { paging = true; reload++ }) { Text("Load more") }
                    }
                }
            }
        }
    }
}

/** What `/` offers: the skills this chat's agent can run. Choosing one adds a chip; the next message carries it. */
@Composable
fun SkillSheet(skills: List<SkillOption>, loaded: Boolean, onDismiss: () -> Unit, onSelect: (SkillOption) -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = "Slash commands") {
        if (!loaded) {
            Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
        } else if (skills.isEmpty()) {
            Text("This agent has no skills to run yet.", Modifier.padding(horizontal = 24.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                items(skills, key = { it.id }) { skill ->
                    SettingsRow("/${skill.name}", icon = ReiIcons.Sparkle, onClick = { onSelect(skill) }, summary = skill.description.ifBlank { null })
                }
            }
        }
    }
}

@Composable
fun ModelSheet(catalog: ModelCatalog, current: String?, onDismiss: () -> Unit, onSelect: (String?) -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = "Model") {
        Column(Modifier.heightIn(max = 480.dp)) {
            Choice("Default (${catalog.label(null)})", selected = current == null, onClick = { onSelect(null) })
            LazyColumn {
                items(catalog.models, key = { it }) { model ->
                    Choice(catalog.label(model), selected = current == model, onClick = { onSelect(model) })
                }
            }
        }
    }
}

@Composable
fun EffortSheet(levels: List<String>, current: String, onDismiss: () -> Unit, onSelect: (String) -> Unit) {
    ReiSheet(onDismiss = onDismiss, title = "Reasoning effort") {
        if (levels.isEmpty()) {
            Text("This model has no reasoning effort to choose.", Modifier.padding(horizontal = 24.dp, vertical = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        levels.forEach { level -> Choice(effortLabel(level), selected = current == level, onClick = { onSelect(level) }) }
    }
}

/**
 * Choose how freely this chat's agent may act: the three levels as radio rows with the web's descriptions. Choosing one
 * saves it ([onSelect]); the caller closes the sheet once that works, so on an error the sheet stays and shows [error].
 * The agent's own default is set on the web, so the last row opens it there.
 */
@Composable
fun PermissionsSheet(
    current: ChatProfile,
    saving: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSelect: (ChatProfile) -> Unit,
    onOpenSettings: () -> Unit,
) {
    ReiSheet(onDismiss = onDismiss, title = "Permissions") {
        Column(Modifier.selectableGroup()) {
            Text(
                "This chat only.",
                Modifier.padding(horizontal = 24.dp).padding(bottom = 4.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ChatProfile.entries.forEach { level ->
                PermissionChoice(level, selected = level == current, enabled = !saving, onClick = { onSelect(level) })
            }
        }
        if (error != null) {
            Text(
                error,
                Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
        HorizontalDivider(Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        SettingsRow(
            "Settings → Permissions",
            // Rows carry 16dp of their own; 8dp more lines the text up with the levels above.
            modifier = Modifier.padding(horizontal = 8.dp),
            icon = ReiIcons.Shield,
            summary = "Sets the level an agent’s new chats start with.",
            onClick = onOpenSettings,
            trailing = { SettingsChevron() },
        )
    }
}

@Composable
private fun PermissionChoice(level: ChatProfile, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        RadioButton(
            selected = selected,
            onClick = null,
            enabled = enabled,
            colors = RadioButtonDefaults.colors(unselectedColor = MaterialTheme.colorScheme.outline),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(level.label, style = MaterialTheme.typography.bodyLarge)
            Text(level.description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** "off" reads "Off", "xhigh" reads "Extra high". */
fun effortLabel(level: String): String = when (level) {
    "xhigh" -> "Extra high"
    else -> level.replaceFirstChar(Char::uppercase)
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit, icon: ImageVector? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (selected) Icon(icon ?: ReiIcons.Check, contentDescription = "Selected", tint = MaterialTheme.colorScheme.primary)
    }
}
