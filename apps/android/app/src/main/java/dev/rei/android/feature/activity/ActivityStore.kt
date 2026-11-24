package dev.rei.android.feature.activity

import androidx.compose.runtime.Immutable
import dev.rei.android.data.ChatCatalogRepository
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApproval
import dev.rei.android.data.SessionRepository
import dev.rei.android.data.objects
import dev.rei.android.data.suspendRunCatching
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

@Immutable
data class ActivityUiState(
    val feed: ActivityFeed = ActivityFeed(),
    /** The first fetch has finished (or failed); until then the list shows a quiet loading line. */
    val loaded: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
    /** Rows whose Retry or Undo is in flight. */
    val busy: Set<String> = emptySet(),
    /** A completed action to say in the snackbar ("Memory change undone"). */
    val notice: String? = null,
    val agentNames: Map<String, String> = emptyMap(),
)

private data class Flags(val refreshing: Boolean = false, val busy: Set<String> = emptySet(), val error: String? = null)

private data class Fetched(
    val jobs: List<BackgroundJob> = emptyList(),
    val triggers: List<TriggerSummary> = emptyList(),
    val changes: Map<String, List<MemoryChange>> = emptyMap(),
    val loaded: Boolean = false,
    val error: String? = null,
)

/**
 * Everything Background Activity shows, and the drawer badge's count. It lives with the shell (not the screen) so the badge
 * counts failures before the page is ever opened. Approvals, takeovers and chat titles come live from the global stream;
 * jobs, trigger runs and memory changes are fetched, again on every `background.changed`, `triggers.changed`,
 * `memory.changed`, reconnect and change in the waiting approvals.
 */
@OptIn(FlowPreview::class)
class ActivityStore(
    private val scope: CoroutineScope,
    private val session: SessionRepository,
    private val catalog: ChatCatalogRepository,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val fetched = MutableStateFlow(Fetched())
    private val flags = MutableStateFlow(Flags())
    private var notice = MutableStateFlow<String?>(null)
    private var fetchJob: Job? = null

    val state: StateFlow<ActivityUiState> = combine(catalog.state, fetched, flags, notice) { live, data, flag, note ->
        val titles = live.sessions.associate { it.id to it.title }
        ActivityUiState(
            feed = buildActivity(live.waitingApprovals, live.takeoverSessionIds, titles, data.jobs, data.triggers, data.changes, clock()),
            loaded = data.loaded,
            refreshing = flag.refreshing,
            error = flag.error ?: data.error,
            busy = flag.busy,
            notice = note,
            agentNames = live.agents.associate { it.id to it.name },
        )
    }.stateIn(scope, SharingStarted.WhileSubscribed(5_000), ActivityUiState())

    init {
        scope.launch {
            session.api.collect { api ->
                fetchJob?.cancel()
                fetched.value = Fetched()
                if (api != null) load(api, pulled = false)
            }
        }
        scope.launch { session.changes.debounce(400).collect { refresh(pulled = false) } }
        scope.launch {
            // A trigger run starts waiting for you without any change notice: its approval is the sign.
            catalog.state.map { live -> live.waitingApprovals.map { it.id }.toSet() + live.takeoverSessionIds }
                .distinctUntilChanged().drop(1).debounce(400).collect { refresh(pulled = false) }
        }
    }

    /** Pull to refresh (or a change notice, with [pulled] false so the spinner stays still). */
    fun refresh(pulled: Boolean = true) {
        val api = session.currentApi ?: return
        load(api, pulled)
    }

    private fun load(api: ReiApi, pulled: Boolean) {
        fetchJob?.cancel()
        if (pulled) flags.update { it.copy(refreshing = true) }
        fetchJob = scope.launch {
            try {
                fetched.value = fetch(api, fetched.value)
            } catch (failure: CancellationException) {
                throw failure
            } finally {
                flags.update { it.copy(refreshing = false) }
            }
        }
    }

    private suspend fun fetch(api: ReiApi, previous: Fetched): Fetched = coroutineScope {
        val jobs = async { suspendRunCatching { parseJobs(api.request("GET", listOf("api", "background"))) } }
        val triggers = async { suspendRunCatching { parseTriggers(api.request("GET", listOf("api", "triggers"))) } }
        val jobResult = jobs.await()
        val triggerResult = triggers.await()
        val list = jobResult.getOrNull() ?: previous.jobs
        val reviewIds = list.filter { it.status == "succeeded" }.sortedByDescending { it.finishedAt ?: it.createdAt }.take(ReviewsWithChanges).map { it.id }
        val details = reviewIds.map { id ->
            async { id to suspendRunCatching { parseMemoryChanges(api.request("GET", listOf("api", "background", id)).objects("changes")) } }
        }.awaitAll()
        val failure = jobResult.exceptionOrNull() ?: triggerResult.exceptionOrNull()
        Fetched(
            jobs = list,
            triggers = triggerResult.getOrNull() ?: previous.triggers,
            changes = details.mapNotNull { (id, result) -> result.getOrNull()?.let { id to it } }.toMap() + previous.changes.filterKeys { key -> details.none { it.first == key && it.second.isSuccess } },
            loaded = true,
            error = failure?.let { it.message ?: "Couldn’t load Background Activity." },
        )
    }

    suspend fun decideApproval(approval: ReiApproval, approve: Boolean, length: String, hours: Int?): ReiApproval =
        session.decideApproval(approval.id, approve, length, hours)

    fun retry(row: FailureRow) {
        val target = row.retry ?: return
        act(row.key, "Retry started") { api ->
            when (target) {
                is RetryTarget.Job -> api.request("POST", listOf("api", "background", target.id, "retry"))
                is RetryTarget.Trigger -> api.request("POST", listOf("api", "triggers", target.id, "run"))
            }
        }
    }

    fun undo(change: MemoryChange) = act("change:${change.id}", "Memory change undone") { api ->
        api.request("POST", listOf("api", "memory", "changes", change.id, "undo"))
    }

    fun consumeNotice() { notice.value = null }

    fun dismissError() { flags.update { it.copy(error = null) } }

    private fun act(key: String, done: String, block: suspend (ReiApi) -> JsonObject) {
        val api = session.currentApi ?: return
        if (key in flags.value.busy) return
        flags.update { it.copy(busy = it.busy + key, error = null) }
        scope.launch {
            try {
                block(api)
                notice.value = done
                load(api, pulled = false)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Exception) {
                flags.update { it.copy(error = failure.message ?: "Couldn’t complete that. Try again.") }
            } finally {
                flags.update { it.copy(busy = it.busy - key) }
            }
        }
    }
}
