package dev.rei.android.shell

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.rei.android.R
import dev.rei.android.data.HistoryHit
import dev.rei.android.ui.components.EmptyState
import dev.rei.android.ui.components.PillField
import dev.rei.android.ui.icons.ReiIcons

/**
 * Full-screen history search, opened from the drawer header. Each result jumps to the exact message in its chat. The
 * query lives in [ShellViewModel] and survives rotation via SavedStateHandle.
 */
@Composable
fun HistorySearchScreen(shell: ShellViewModel, onOpened: () -> Unit, modifier: Modifier = Modifier) {
    val state by shell.search.collectAsStateWithLifecycle()
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { focus.requestFocus() }
    Column(modifier.fillMaxSize()) {
        val searchLabel = stringResource(R.string.drawer_search_chats)
        ReiTopBar(searchLabel, onBack = LocalShell.current::back)
        PillField(
            value = state.query,
            onValueChange = shell::setQuery,
            placeholder = searchLabel,
            description = searchLabel,
            leadingIcon = ReiIcons.Search,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).focusRequester(focus),
            keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); shell.setQuery(state.query) }),
        )
        when {
            state.query.isBlank() -> EmptyState(
                ReiIcons.Search,
                stringResource(R.string.drawer_search_empty_title),
                body = stringResource(R.string.drawer_search_empty_body),
            )
            state.hits.isEmpty() -> Text(
                state.status?.asString().orEmpty(),
                Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(state.hits, key = HistoryHit::id) { hit ->
                    Column(
                        Modifier.fillMaxWidth().clickable { shell.openHit(hit); onOpened() }.padding(horizontal = 24.dp, vertical = 12.dp),
                    ) {
                        Text(hit.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            hit.snippet,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}
