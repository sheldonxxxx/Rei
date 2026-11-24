package dev.rei.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameAreaTest {
    @Test
    fun letterboxesInBothOrientations() {
        val portrait = FrameArea.fit(400f, 800f, 1000f, 500f, 1f, 0f, 0f)
        assertNull(portrait.source(200f, 280f, 1000f, 500f, false))
        assertEquals(500f to 250f, portrait.source(200f, 400f, 1000f, 500f, false))

        val landscape = FrameArea.fit(800f, 400f, 1000f, 500f, 1f, 0f, 0f)
        assertEquals(500f to 250f, landscape.source(400f, 200f, 1000f, 500f, false))
    }

    @Test
    fun mapsZoomAndPanAndClampsAnOutOfBoundsDrag() {
        val area = FrameArea.fit(400f, 300f, 800f, 600f, 2f, 500f, -100f)
        assertEquals(200f, area.panX)
        assertEquals(-100f, area.panY)
        assertEquals(200f to 400f, area.source(200f, 150f, 800f, 600f, false))
        assertEquals(0f to 599f, area.source(-20f, 1000f, 800f, 600f, true))
    }
}
