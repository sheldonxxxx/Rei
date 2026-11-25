package dev.rei.android.feature.settings

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SettingsSupportTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun distinctSlotsWithSameKeyKeepIndependentResources() = runTest(dispatcher) {
        val vm = SettingsScreenViewModel()
        val key = "api"
        val docs = vm.resource("memory.docs", key) { listOf("doc1") }
        val names = vm.resource("memory.agentNames", key) { mapOf("a1" to "Rei") }

        assertNotSame(docs, names)
        advanceUntilIdle()

        assertEquals(listOf("doc1"), docs.value)
        assertEquals(mapOf("a1" to "Rei"), names.value)
    }

    @Test
    fun distinctSlotsWithDifferentKeysDoNotResetEachOther() = runTest(dispatcher) {
        val vm = SettingsScreenViewModel()
        val agents = vm.resource("usage.agents", "api") { mapOf("a1" to "Rei") }
        val report = vm.resource("usage.report", "30d") { 42 }
        advanceUntilIdle()

        // Recomposition-like second lookup with different keys per slot preserves loaded values.
        assertSame(agents, vm.resource("usage.agents", "api") { error("should not reload") })
        assertSame(report, vm.resource("usage.report", "30d") { error("should not reload") })
        assertEquals(mapOf("a1" to "Rei"), agents.value)
        assertEquals(42, report.value)
    }

    @Test
    fun sameSlotReloadsWhenKeyChanges() = runTest(dispatcher) {
        val vm = SettingsScreenViewModel()
        val first = vm.resource("memory.history", "line-1") { "v1" }
        advanceUntilIdle()
        assertEquals("v1", first.value)

        val changed = vm.resource("memory.history", "line-2") { "v2" }
        assertNull(changed.value)
        advanceUntilIdle()
        assertEquals("v2", changed.value)
    }
}
