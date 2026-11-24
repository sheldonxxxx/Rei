package dev.rei.android.feature.knowledge

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.ReiViewModel
import dev.rei.android.data.KnowledgePageData
import dev.rei.android.data.ReiApi
import dev.rei.android.data.restoreKnowledgePage
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.LocalNotices
import dev.rei.android.ui.components.ReiIconButton
import dev.rei.android.ui.components.ReiTextField
import dev.rei.android.ui.components.StatusBanner
import dev.rei.android.ui.components.StatusKind
import dev.rei.android.ui.components.markdown.ReiMarkdown
import dev.rei.android.ui.components.workspace.RemovableChip
import dev.rei.android.ui.icons.ReiIcons
import dev.rei.android.ui.theme.ReiShapes
import dev.rei.android.ui.theme.tabular

/**
 * One Knowledge page: the read view first, an editor behind the Edit icon. [target] is a page id or [NewPageTarget];
 * [onOpenPage] follows a breadcrumb or sub-page link; [onClose] leaves the screen.
 */
@Composable
fun KnowledgePageScreen(model: ReiViewModel, api: ReiApi, target: String, onOpenPage: (String) -> Unit, onClose: () -> Unit) {
    val vm: KnowledgePageViewModel = viewModel(factory = KnowledgePageViewModel.factory(model))
    LaunchedEffect(target) { vm.open(target) }
    // Closing forgets the page, so opening it again loads it fresh.
    DisposableEffect(vm) { onDispose { vm.forget() } }
    val state by vm.state.collectAsStateWithLifecycle()
    val notices = LocalNotices.current
    val context = LocalContext.current
    var discard by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    fun back() {
        when {
            state.editing && state.dirty -> discard = true
            state.editing && !state.isNew -> vm.cancelEdit()
            else -> onClose()
        }
    }
    BackHandler(onBack = ::back)

    KnowledgePageContent(
        state = state,
        api = api,
        menuOpen = menu,
        onMenu = { menu = it },
        onBack = ::back,
        onEdit = vm::edit,
        onSave = { vm.save() },
        onTitle = vm::setTitle,
        onDescription = vm::setDescription,
        onBody = vm::setBody,
        onTagEntry = vm::setTagEntry,
        onCommitTag = vm::commitTag,
        onRemoveTag = vm::removeTag,
        onReload = vm::reloadLatest,
        onRetry = vm::retry,
        onOpenPage = onOpenPage,
        onFavorite = vm::togglePinned,
        onTrash = {
            vm.trash(
                done = { title, id ->
                    onClose()
                    notices?.show("Moved “$title” to Trash", "Undo") {
                        notices.launch {
                            try {
                                api.restoreKnowledgePage(id)
                                dev.rei.android.data.WorkspaceChanges.pagesChanged()
                            } catch (failure: kotlinx.coroutines.CancellationException) {
                                throw failure
                            } catch (failure: Exception) {
                                notices.show(failure.localizedMessage ?: "Could not restore the page.")
                            }
                        }
                    }
                },
                failed = { notices?.show(it) },
            )
        },
        onRestore = { vm.restore(done = { notices?.show("Restored “$it”") }, failed = { notices?.show(it) }) },
    )
    if (discard) {
        ConfirmDialog(
            title = "Discard changes?",
            text = "What you typed on this page won’t be saved.",
            confirmLabel = "Discard",
            destructive = true,
            onConfirm = { discard = false; if (state.isNew) onClose() else vm.cancelEdit() },
            onDismiss = { discard = false },
        )
    }
}

/** Stateless page view and editor, for previews and tests. */
@Composable
fun KnowledgePageContent(
    state: PageUiState,
    api: ReiApi?,
    menuOpen: Boolean,
    onMenu: (Boolean) -> Unit,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onSave: () -> Unit,
    onTitle: (String) -> Unit,
    onDescription: (String) -> Unit,
    onBody: (String) -> Unit,
    onTagEntry: (String) -> Unit,
    onCommitTag: () -> Unit,
    onRemoveTag: (String) -> Unit,
    onReload: () -> Unit,
    onRetry: () -> Unit,
    onOpenPage: (String) -> Unit,
    onFavorite: () -> Unit,
    onTrash: () -> Unit,
    onRestore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val page = state.page
    Column(modifier.fillMaxSize()) {
        if (state.editing) {
            ReiTopBar(
                title = if (state.isNew) "New page" else "Edit page",
                onBack = onBack,
                actions = {
                    Button(onSave, enabled = state.canSave, modifier = Modifier.padding(end = 8.dp)) {
                        Text(if (state.saving) "Saving…" else "Save")
                    }
                },
            )
        } else {
            ReiTopBar(
                title = "",
                onBack = onBack,
                actions = {
                    ReiIconButton(ReiIcons.Edit, "Edit", onEdit, enabled = page != null && !page.locked && !page.trashed)
                    ReiIconButton(ReiIcons.MoreVertical, "More options", { onMenu(true) }, enabled = page != null)
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { onMenu(false) }) {
                        if (page != null) {
                            DropdownMenuItem(
                                text = { Text(if (page.pinned) "Remove from favorites" else "Add to favorites") },
                                leadingIcon = { Icon(ReiIcons.Star, null) },
                                onClick = { onMenu(false); onFavorite() },
                            )
                            if (page.trashed) {
                                DropdownMenuItem(text = { Text("Restore") }, leadingIcon = { Icon(ReiIcons.Undo, null) }, onClick = { onMenu(false); onRestore() })
                            } else {
                                DropdownMenuItem(
                                    text = { Text("Move to Trash", color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(ReiIcons.Trash, null, tint = MaterialTheme.colorScheme.error) },
                                    onClick = { onMenu(false); onTrash() },
                                )
                            }
                        }
                    }
                },
            )
        }
        when {
            state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp) }
            state.error != null -> EmptyState(ReiIcons.Alert, "Couldn’t open this page", body = state.error) { OutlinedButton(onRetry) { Text("Try again") } }
            state.editing -> PageEditor(state, onTitle, onDescription, onBody, onTagEntry, onCommitTag, onRemoveTag, onReload)
            page != null -> PageReader(page, api, onOpenPage, onRestore)
        }
    }
}

@Composable
private fun PageReader(page: KnowledgePageData, api: ReiApi?, onOpenPage: (String) -> Unit, onRestore: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val context = LocalContext.current
    val updated = remember(page.updatedAt) { relative(context, page.updatedAt) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (page.trashed) StatusBanner("This page is in Trash.", actionLabel = "Restore", onAction = onRestore)
        if (page.locked) StatusBanner("This page is locked. Open it in Rei web to change it.")
        if (page.ancestors.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                page.ancestors.forEachIndexed { index, ancestor ->
                    Text(
                        ancestor.title,
                        Modifier.clickable(role = Role.Button) { onOpenPage(ancestor.id) },
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.primary,
                    )
                    if (index != page.ancestors.lastIndex) Text("/", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                }
            }
        }
        Text(page.title, style = MaterialTheme.typography.headlineMedium)
        if (page.description.isNotBlank()) Text(page.description, style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant)
        if (page.tags.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                page.tags.forEach { tag ->
                    Surface(shape = ReiShapes.Pill, color = colors.surfaceContainerHigh) {
                        Text("#$tag", Modifier.padding(horizontal = 10.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
        Text(
            buildString { if (page.updatedBy.isNotBlank()) append("Updated by ${page.updatedBy} · "); append(updated); append(" · revision ${page.revision}") },
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = colors.onSurfaceVariant,
        )
        HorizontalDivider(color = colors.outlineVariant)
        if (page.body.isBlank()) Text("This page has no text yet.", color = colors.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        else if (api != null) ReiMarkdown(page.body, api)
        if (page.children.isNotEmpty()) {
            HorizontalDivider(color = colors.outlineVariant)
            Text("Sub-pages", style = MaterialTheme.typography.titleSmall, color = colors.onSurfaceVariant)
            page.children.forEach { child ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) { onOpenPage(child.id) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(ReiIcons.Page, null, Modifier.size(20.dp), tint = colors.onSurfaceVariant)
                    Text(child.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Box(Modifier.size(24.dp))
    }
}

@Composable
private fun PageEditor(
    state: PageUiState,
    onTitle: (String) -> Unit,
    onDescription: (String) -> Unit,
    onBody: (String) -> Unit,
    onTagEntry: (String) -> Unit,
    onCommitTag: () -> Unit,
    onRemoveTag: (String) -> Unit,
    onReload: () -> Unit,
) {
    val draft = state.draft
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        state.saveError?.let { message ->
            if (state.conflict) StatusBanner("$message Reload to see the latest version; your edits here will be discarded.", kind = StatusKind.Error, actionLabel = "Reload page", onAction = onReload)
            else StatusBanner(message, kind = StatusKind.Error)
        }
        ReiTextField(draft.title, onTitle, "Title", error = if (draft.title.isBlank() && state.dirty) "A title is required." else null,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next))
        ReiTextField(draft.description, onDescription, "Description", singleLine = false, minLines = 2, maxLines = 4,
            supportingText = "A short summary shown in the page list.",
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
        ReiTextField(draft.body, onBody, "Body", singleLine = false, minLines = 10,
            supportingText = "Markdown.",
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Tags", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (draft.tags.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    draft.tags.forEach { tag -> RemovableChip("#$tag", { onRemoveTag(tag) }, noun = "tag") }
                }
            }
            ReiTextField(
                state.tagEntry, onTagEntry, "Add a tag", error = state.tagError,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onCommitTag() }),
                trailingContent = { TextButton(onCommitTag, enabled = state.tagEntry.isNotBlank()) { Text("Add") } },
            )
        }
        Box(Modifier.size(24.dp))
    }
}
