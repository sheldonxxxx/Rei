package dev.rei.android.ui.components.chat

import dev.rei.android.ui.UiText
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfaceResolveTest {
    private fun components(json: String): Map<String, JsonObject> =
        Json.parseToJsonElement(json).jsonArray.associate { it.jsonObject["id"].toString().trim('"') to it.jsonObject }

    private fun data(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test
    fun resolvesBoundTextAndButtonsIntoReadyValues() {
        val spec = resolveSurface(
            components(
                """[
                  {"id":"root","component":"Column","children":["greeting","go"]},
                  {"id":"greeting","component":"Text","text":{"@call":"formatString","args":{"value":"Hi ${'$'}{/name}"}}},
                  {"id":"go","component":"Button","child":"go-label","action":{"event":{"name":"go"}}},
                  {"id":"go-label","component":"Text","text":"Start"}
                ]""",
            ),
            data("""{"name":"Rei"}"""),
        ) as SurfaceSpec.Stack
        assertEquals(SurfaceSpec.Markdown("Hi Rei"), spec.children[0])
        assertEquals(UiText.Literal("Start"), (spec.children[1] as SurfaceSpec.Action).label)
    }

    @Test
    fun refusesSurfacesThatRepeatIntoTooManyParts() {
        val rows = (1..100).joinToString(",") { """{"cells":[${(1..100).joinToString(",")}]}""" }
        val surface = components(
            """[
              {"id":"root","component":"Column","children":{"componentId":"row","path":"/rows"}},
              {"id":"row","component":"Row","children":{"componentId":"cell","path":"cells"}},
              {"id":"cell","component":"Text","text":"x"}
            ]""",
        )
        assertThrows(SurfaceTooLarge::class.java) { resolveSurface(surface, data("""{"rows":[$rows]}""")) }
    }

    @Test
    fun dropsPartsWithValuesItCannotDraw() {
        val spec = resolveSurface(
            components(
                """[
                  {"id":"root","component":"Column","children":["slider","chart","missing","card"]},
                  {"id":"slider","component":"Slider","min":10,"max":1,"value":5},
                  {"id":"chart","component":"Chart","labels":["a"],"series":[{"name":"s","values":["NaN","x"]}]},
                  {"id":"card","component":"Card","child":"card"}
                ]""",
            ),
            data("{}"),
        ) as SurfaceSpec.Stack
        assertEquals(SurfaceSpec.Empty, spec.children[0])
        assertEquals(listOf<Float?>(null, null), (spec.children[1] as SurfaceSpec.Chart).series.single().second)
        assertEquals(SurfaceSpec.Empty, spec.children[2])
        // A card that contains itself stops at the depth limit instead of recursing forever.
        assertTrue(spec.children[3] is SurfaceSpec.Boxed)
    }
}
