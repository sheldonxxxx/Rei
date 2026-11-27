package dev.rei.android.feature.chat

import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Past any real item height, so scrolling to the last item by this much lands on the very end. */
private const val PastTheEnd = Int.MAX_VALUE / 2

/** How close to the end, in pixels, still counts as being there. */
private const val EndSlack = 48

/** How far the end of the list is below the viewport, in pixels; null while the last item is not on screen. */
private fun LazyListLayoutInfo.distanceToEnd(): Int? {
    val last = visibleItemsInfo.lastOrNull() ?: return 0
    if (last.index != totalItemsCount - 1) return null
    return (last.offset + last.size + afterContentPadding - viewportEndOffset).coerceAtLeast(0)
}

internal fun LazyListLayoutInfo.isAtEnd(): Boolean = distanceToEnd()?.let { it <= EndSlack } == true

/**
 * Whether the transcript keeps its newest content on screen. The reader lets go of the end by scrolling away from it and
 * takes it back by scrolling there again; a reply that is being written never moves a reader who has let go.
 *
 * The list runs from the top (oldest first), so its position holds on to what is on screen while content grows below.
 * Staying at the end is therefore something done on purpose, by [follow].
 */
@Stable
internal class TranscriptFollow(private val list: LazyListState, following: Boolean = true) {
    var following by mutableStateOf(following)
        private set

    private var opened = false

    /** Scrolls of our own that are running; they say nothing about what the reader wants. */
    private var ownScrolls = 0

    /** Called while composing, so that the first frame with [count] items is already at the end. */
    fun openAtEnd(count: Int) {
        if (opened || count == 0) return
        opened = true
        if (following) list.requestScrollToItem(count - 1, PastTheEnd)
    }

    /** Takes the end back; [follow] does the scrolling. */
    fun resume() {
        following = true
    }

    /** Shows the item at [index], which lets go of the end unless that is where it lands. */
    suspend fun show(index: Int, scrollOffset: Int) {
        following = false
        own { list.scrollToItem(index, scrollOffset) }
        following = list.layoutInfo.isAtEnd()
    }

    suspend fun jumpToEnd(animate: Boolean) = own {
        following = true
        scrollToEnd(animate)
    }

    /** Keeps the list at the end while [following], and watches the reader's scrolling, until cancelled. */
    suspend fun follow(animateNewItems: () -> Boolean) {
        var count = 0
        var readerScrolling = false
        var reachedEnd = false
        snapshotFlow {
            listOf(
                following, list.isScrollInProgress, list.canScrollForward, list.layoutInfo.totalItemsCount,
                list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset,
            )
        }.collect {
            val total = list.layoutInfo.totalItemsCount
            val added = count > 0 && total > count
            count = total
            when {
                list.isScrollInProgress -> if (ownScrolls == 0) {
                    readerScrolling = true
                    following = false
                    // Remembered, because more may arrive between reaching the end and the scroll coming to rest.
                    if (!list.canScrollForward) reachedEnd = true else if (list.lastScrolledBackward) reachedEnd = false
                }
                readerScrolling -> {
                    readerScrolling = false
                    following = reachedEnd || list.layoutInfo.isAtEnd()
                    reachedEnd = false
                }
                following && list.canScrollForward -> own { scrollToEnd(animate = added && animateNewItems()) }
            }
        }
    }

    private suspend fun scrollToEnd(animate: Boolean) {
        val end = list.layoutInfo.totalItemsCount - 1
        if (end < 0) return
        if (animate) {
            if (list.layoutInfo.visibleItemsInfo.none { it.index == end }) list.animateScrollToItem(end)
            list.layoutInfo.distanceToEnd()?.let { list.animateScrollBy(it.toFloat()) }
        }
        list.scrollToItem(end, PastTheEnd)
    }

    private suspend fun own(scroll: suspend () -> Unit) {
        ownScrolls++
        try {
            scroll()
        } catch (_: CancellationException) {
            // The reader's touch outranks our scroll and cancels it. Only our own cancellation goes any further.
            currentCoroutineContext().ensureActive()
        } finally {
            ownScrolls--
        }
    }
}

/** The follow state for [list], which holds [count] items now. It survives configuration changes with the position. */
@Composable
internal fun rememberTranscriptFollow(list: LazyListState, count: Int): TranscriptFollow {
    val follow = rememberSaveable(
        list,
        saver = Saver<TranscriptFollow, Boolean>(save = { it.following }, restore = { TranscriptFollow(list, it) }),
    ) { TranscriptFollow(list) }
    follow.openAtEnd(count)
    return follow
}
