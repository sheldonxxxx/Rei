package dev.rei.android.ui.components

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.rei.android.data.ReiApi
import dev.rei.android.ui.components.chat.InlineSurface
import dev.rei.android.ui.theme.ReiTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test

class SurfaceFallbackTest {
    @get:Rule
    val compose = createComposeRule()

    private val api = ReiApi("http://127.0.0.1:1")

    private fun surface(components: String, dataModel: String): JsonObject = Json.parseToJsonElement(
        """{
          "surfaceId":"s1","state":"frozen","sessionId":"ses1","title":"Plan","revision":1,"protocolVersion":"1.0",
          "fallback":"Plan: three steps",
          "message":{"createSurface":{"catalogId":"rei/catalog/1","components":$components,"dataModel":$dataModel}}
        }""",
    ).jsonObject

    @Test
    fun drawsAWorkingSurface() {
        compose.setContent {
            ReiTheme {
                InlineSurface(api, "ses1", surface("""[{"id":"root","component":"Text","text":"First step"}]""", "{}"))
            }
        }
        compose.onNodeWithText("First step").assertIsDisplayed()
    }

    @Test
    fun showsTheFallbackTextWhenASurfaceCannotBeDrawn() {
        val rows = (1..100).joinToString(",") { """{"cells":[${(1..100).joinToString(",")}]}""" }
        compose.setContent {
            ReiTheme {
                InlineSurface(
                    api,
                    "ses1",
                    surface(
                        """[
                          {"id":"root","component":"Column","children":{"componentId":"row","path":"/rows"}},
                          {"id":"row","component":"Row","children":{"componentId":"cell","path":"cells"}},
                          {"id":"cell","component":"Text","text":"x"}
                        ]""",
                        """{"rows":[$rows]}""",
                    ),
                )
            }
        }
        compose.onNodeWithText("Plan: three steps").assertIsDisplayed()
        compose.onNodeWithText("This surface couldn't be drawn here. Inspect it for details.").assertIsDisplayed()
    }
}
