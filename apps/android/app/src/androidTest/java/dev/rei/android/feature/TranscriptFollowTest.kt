package dev.rei.android.feature

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.unit.dp
import dev.rei.android.feature.chat.TranscriptFollow
import dev.rei.android.feature.chat.isAtEnd
import dev.rei.android.feature.chat.rememberTranscriptFollow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Scrolling a transcript while its last reply is still being written. */
class TranscriptFollowTest {
    @get:Rule
    val compose = createComposeRule()

    private var rows by mutableStateOf((1..12).map { "row-$it" })

    /** The height of the last row, which grows as a reply streams. */
    private var replyHeight by mutableStateOf(200)
    private lateinit var list: LazyListState
    private lateinit var follow: TranscriptFollow
    private lateinit var scope: CoroutineScope

    private fun show(animate: Boolean = false) {
        compose.setContent {
            list = rememberLazyListState()
            follow = rememberTranscriptFollow(list, rows.size)
            scope = rememberCoroutineScope()
            LaunchedEffect(follow) { follow.follow { animate } }
            LazyColumn(
                state = list,
                modifier = Modifier.size(300.dp, 400.dp).testTag("list"),
                verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom),
            ) {
                items(rows, key = { it }) { row ->
                    Text(row, Modifier.fillMaxWidth().height(if (row == rows.last()) replyHeight.dp else 80.dp))
                }
            }
        }
        compose.waitForIdle()
    }

    private fun stream(by: Int = 120) {
        replyHeight += by
        compose.waitForIdle()
    }

    private fun readOlder() {
        compose.onNodeWithTag("list").performTouchInput { swipeDown(startY = top + 20f, endY = bottom - 20f, durationMillis = 400) }
        compose.waitForIdle()
    }

    private fun position() = compose.runOnIdle { list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset }
    private fun atEnd() = compose.runOnIdle { list.layoutInfo.isAtEnd() && !list.canScrollForward }

    @Test
    fun opensAtTheEndAndStaysThereWhileTheReplyGrows() {
        show()
        assertTrue(atEnd())
        repeat(5) {
            stream()
            assertTrue(atEnd())
        }
        // Taller than the screen by now, and still followed.
        stream(900)
        assertTrue(atEnd())
    }

    @Test
    fun aReaderWhoScrollsAwayIsNeverMovedByTheReply() {
        show()
        readOlder()
        assertFalse(compose.runOnIdle { follow.following })
        val reading = position()
        repeat(5) {
            stream()
            assertEquals(reading, position())
        }
    }

    @Test
    fun aReaderInsideTheGrowingReplyKeepsTheirPlace() {
        replyHeight = 1_200
        show()
        compose.onNodeWithTag("list").performTouchInput { swipeDown(startY = centerY - 60f, endY = centerY + 60f, durationMillis = 400) }
        compose.waitForIdle()
        assertFalse(compose.runOnIdle { follow.following })
        val reading = position()
        assertEquals(rows.lastIndex, reading.first)
        repeat(5) {
            stream()
            assertEquals(reading, position())
        }
    }

    @Test
    fun scrollingBackToTheEndFollowsAgain() {
        show()
        readOlder()
        repeat(3) {
            compose.onNodeWithTag("list").performTouchInput { swipeUp() }
            compose.waitForIdle()
        }
        assertTrue(compose.runOnIdle { follow.following })
        stream()
        assertTrue(atEnd())
    }

    @Test
    fun jumpingToTheEndFollowsAgain() {
        show()
        readOlder()
        stream(900)
        compose.runOnIdle { scope.launch { follow.jumpToEnd(animate = true) } }
        compose.waitForIdle()
        assertTrue(atEnd())
        stream()
        assertTrue(atEnd())
    }

    @Test
    fun newRowsAreFollowedOnlyWhileFollowing() {
        show(animate = true)
        compose.runOnIdle { rows = rows + "next" }
        compose.waitForIdle()
        assertTrue(atEnd())
        readOlder()
        val reading = position()
        compose.runOnIdle { rows = rows + "later" }
        compose.waitForIdle()
        assertEquals(reading, position())
    }

    @Test
    fun olderRowsAddedAboveDoNotMoveTheReader() {
        show()
        readOlder()
        readOlder()
        val first = compose.runOnIdle { list.layoutInfo.visibleItemsInfo.first().let { it.key to it.offset } }
        compose.runOnIdle { rows = (1..30).map { "older-$it" } + rows }
        compose.waitForIdle()
        assertEquals(first, compose.runOnIdle { list.layoutInfo.visibleItemsInfo.first().let { it.key to it.offset } })
    }
}
