package dev.rei.android.feature.settings

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsTest {
    @Test
    fun readsCapabilitiesWithNullValues() {
        val body = buildJsonObject {
            put("capabilities", buildJsonArray {
                add(buildJsonObject {
                    put("id", "a/gpt")
                    put("contextWindow", buildJsonObject { put("value", 128000); put("source", "custom") })
                    put("maxTokens", buildJsonObject { put("value", JsonNull); put("source", "unknown") })
                })
            })
        }
        val capability = parseCapabilities(body).single()
        assertEquals("a/gpt", capability.id)
        assertEquals(Limit(128000, "custom"), capability.contextWindow)
        assertEquals(Limit(null, "unknown"), capability.maxTokens)
    }

    @Test
    fun onlyUserValuesAreEditable() {
        assertEquals("128000", customLimitText(Limit(128000, "custom")))
        assertEquals("", customLimitText(Limit(128000, "detected")))
        assertEquals("", customLimitText(Limit(null, null)))
    }

    @Test
    fun limitPatchSetsAndClears() {
        val (patch, message) = limitPatch("Model", "200000", "")
        assertNull(message)
        assertNotNull(patch)
        assertEquals(JsonPrimitive(200000L), patch!!["contextWindow"])
        assertEquals(JsonNull, patch["maxTokens"])
    }

    @Test
    fun limitPatchNamesTheBadField() {
        val (patch, message) = limitPatch("Model", "12", "abc")
        assertNull(patch)
        assertEquals("Max output tokens for Model must be a whole number above 0.", message)
        assertEquals("Context window for Model must be a whole number above 0.", limitPatch("Model", "0", "").second)
    }
}
