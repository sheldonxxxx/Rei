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
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.rei.android.R
import dev.rei.android.data.KnowledgePageData
import dev.rei.android.data.ReiApi
import dev.rei.android.di.AppContainer
import dev.rei.android.shell.ReiTopBar
import dev.rei.android.ui.components.ConfirmDialog
import dev.rei.android.ui.components.EmptyState
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
fun KnowledgePageScreen(
    container: AppContainer,
    api: ReiApi,
    target: String,
    onOpenPage: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    onDirtyChanged: (Boolean) -> Unit = {},
    showBack: Boolean = true,
    viewModelKey: String = target,
) {
    val vm: KnowledgePageViewModel = viewModel(key = viewModelKey, factory = KnowledgePageViewModel.factory(target, container))
    val state by vm.state.collectAsStateWithLifecycle()
    var discard by rememberSaveable { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }

    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                PageEvent.Close -> onClose()
            }
        }
    }
    LaunchedEffect(state.dirty) { onDirtyChanged(state.dirty) }
    DisposableEffect(Unit) { onDispose { onDirtyChanged(false) } }

    fun back() {
        when {
            state.editing && state.dirty -> discard = true
            state.editing && !state.isNew -> vm.cancelEdit()
            else -> onClose()
        }
    }
    // Only intercept system back when editing; otherwise NavHost drives native Predictive Back.
    BackHandler(enabled = state.editing, onBack = ::back)

    KnowledgePageContent(
        state = state,
        api = api,
        menuOpen = menu,
        onMenu = { menu = it },
        onBack = if (showBack || state.editing) ::back else null,
        onEdit = vm::edit,
        onSave = vm::save,
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
        onTrash = vm::trash,
        onRestore = vm::restore,
        modifier = modifier,
    )
    if (discard) {
        ConfirmDialog(
            title = stringResource(R.string.knowledge_page_discard_title),
            text = stringResource(R.string.knowledge_page_discard_body),
            confirmLabel = stringResource(R.string.knowledge_page_discard_action),
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
    onBack: (() -> Unit)?,
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
                title = stringResource(if (state.isNew) R.string.knowledge_new_page else R.string.knowledge_page_edit_title),
                onBack = onBack,
                actions = {
                    Button(onSave, enabled = state.canSave, modifier = Modifier.padding(end = 8.dp)) {
                        Text(stringResource(if (state.saving) R.string.knowledge_page_saving else R.string.common_save))
                    }
                },
            )
        } else {
            ReiTopBar(
                title = "",
                onBack = onBack,
                actions = {
                    ReiIconButton(ReiIcons.Edit, stringResource(R.string.knowledge_page_edit), onEdit, enabled = page != null && !page.locked && !page.trashed)
                    ReiIconButton(ReiIcons.MoreVertical, stringResource(R.string.knowledge_page_more_options), { onMenu(true) }, enabled = page != null)
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { onMenu(false) }) {
                        if (page != null) {
                            DropdownMenuItem(
                                text = { Text(stringResource(if (page.pinned) R.string.knowledge_page_favorite_remove else R.string.knowledge_page_favorite_add)) },
                                leadingIcon = { Icon(ReiIcons.Star, null) },
                                onClick = { onMenu(false); onFavorite() },
                            )
                            if (page.trashed) {
                                DropdownMenuItem(text = { Text(stringResource(R.string.knowledge_restore)) }, leadingIcon = { Icon(ReiIcons.Undo, null) }, onClick = { onMenu(false); onRestore() })
                            } else {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.knowledge_page_move_to_trash), color = MaterialTheme.colorScheme.error) },
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
            state.error != null -> EmptyState(ReiIcons.Alert, stringResource(R.string.knowledge_page_open_failed_title), body = state.error.asString()) {
                OutlinedButton(onRetry) { Text(stringResource(R.string.common_try_again)) }
            }
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
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 760.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
        if (page.trashed) StatusBanner(stringResource(R.string.knowledge_page_in_trash), actionLabel = stringResource(R.string.knowledge_restore), onAction = onRestore)
        if (page.locked) StatusBanner(stringResource(R.string.knowledge_page_locked_banner))
        if (page.ancestors.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                page.ancestors.forEachIndexed { index, ancestor ->
                    Box(
                        Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { onOpenPage(ancestor.id) }.padding(horizontal = 2.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            ancestor.title,
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.primary,
                        )
                    }
                    if (index != page.ancestors.lastIndex) Text("/", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                }
            }
        }
        Text(page.title, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium)
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
            buildString {
                if (page.updatedBy.isNotBlank()) append(stringResource(R.string.knowledge_page_updated_by, page.updatedBy))
                append(updated)
                append(stringResource(R.string.knowledge_page_revision, page.revision))
            },
            style = MaterialTheme.typography.labelSmall.tabular(),
            color = colors.onSurfaceVariant,
        )
        HorizontalDivider(color = colors.outlineVariant)
        if (page.body.isBlank()) Text(stringResource(R.string.knowledge_page_empty_body), color = colors.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        else if (api != null) ReiMarkdown(page.body, api)
        if (page.children.isNotEmpty()) {
            HorizontalDivider(color = colors.outlineVariant)
            Text(stringResource(R.string.knowledge_page_subpages), style = MaterialTheme.typography.titleSmall, color = colors.onSurfaceVariant)
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
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier.widthIn(max = 760.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
        state.saveError?.asString()?.let { message ->
            if (state.conflict) {
                StatusBanner(
                    stringResource(R.string.knowledge_page_conflict_msg, message),
                    kind = StatusKind.Error,
                    actionLabel = stringResource(R.string.knowledge_page_reload),
                    onAction = onReload,
                )
            } else {
                StatusBanner(message, kind = StatusKind.Error)
            }
        }
        ReiTextField(
            draft.title,
            onTitle,
            stringResource(R.string.knowledge_page_field_title),
            error = if (draft.title.isBlank() && state.dirty) stringResource(R.string.knowledge_page_title_required) else null,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
        )
        ReiTextField(
            draft.description,
            onDescription,
            stringResource(R.string.knowledge_page_field_description),
            singleLine = false,
            minLines = 2,
            maxLines = 4,
            supportingText = stringResource(R.string.knowledge_page_description_hint),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        ReiTextField(
            draft.body,
            onBody,
            stringResource(R.string.knowledge_page_field_body),
            singleLine = false,
            minLines = 10,
            supportingText = stringResource(R.string.knowledge_page_body_hint),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.knowledge_tags), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (draft.tags.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    draft.tags.forEach { tag ->
                        RemovableChip(
                            label = "#$tag",
                            onRemove = { onRemoveTag(tag) },
                            removeContentDescription = stringResource(R.string.common_remove_tag, tag),
                        )
                    }
                }
            }
            ReiTextField(
                state.tagEntry,
                onTagEntry,
                stringResource(R.string.knowledge_page_add_tag),
                error = state.tagError?.asString(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onCommitTag() }),
                trailingContent = { TextButton(onCommitTag, enabled = state.tagEntry.isNotBlank()) { Text(stringResource(R.string.knowledge_page_add)) } },
            )
        }
        Box(Modifier.size(24.dp))
    }
    }
}
