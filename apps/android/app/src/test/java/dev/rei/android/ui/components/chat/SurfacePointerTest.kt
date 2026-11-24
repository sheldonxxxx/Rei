package dev.rei.android.ui.components.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SurfacePointerTest {
    @Test
    fun surfaceResolvesScopedBindingsAndRetainsNestedSiblingsOnEdit() {
        val data = Json.parseToJsonElement("""{"items":[{"label":"First","enabled":false},{"label":"Second"}],"a/b":5}""").jsonObject
        val changed = pointerSet(data, "/items/0/enabled", JsonPrimitive(true)) as JsonObject
        assertEquals(JsonPrimitive("First"), pointerGet(changed, "/items/0/label"))
        assertEquals(JsonPrimitive("Second"), pointerGet(changed, "/items/1/label"))
        assertEquals(JsonPrimitive(true), surfaceValue(Json.parseToJsonElement("""{"@path":"enabled"}"""), changed, "/items/0"))
        assertEquals(JsonPrimitive(5), pointerGet(changed, "/a~1b"))
        val dynamic = Json.parseToJsonElement("""{"@call":"formatString","args":{"value":"Item ${'$'}{label}"}}""")
        assertEquals(JsonPrimitive("Item First"), surfaceValue(dynamic, changed, "/items/0"))
    }
}
