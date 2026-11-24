package dev.rei.android.ui.components

import dev.rei.android.ui.components.chat.surfaceValue
import dev.rei.android.ui.components.markdown.markdownWithCitations
import dev.rei.android.ui.components.markdown.spokenText
import dev.rei.android.ui.components.markdown.tokenizeCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android compiles regexes with ICU, which rejects some patterns the JVM accepts (an unescaped `}`, for one).
 * JVM unit tests cannot catch that, so this runs the code that owns each top-level pattern on a device.
 */
class RegexOnDeviceTest {
    @Test
    fun surfaceFormatStringInterpolatesAndKeepsEscapes() {
        val data = Json.parseToJsonElement("""{"name":"Rei"}""").jsonObject
        val call = Json.parseToJsonElement(
            """{"@call":"formatString","args":{"value":"Hi ${'$'}{/name}, \\${'$'}{kept}"}}""",
        )
        assertEquals(JsonPrimitive("Hi Rei, ${'$'}{kept}"), surfaceValue(call, data, ""))
    }

    @Test
    fun markdownPatternsCompile() {
        assertEquals("Heading.\nA link", spokenText("# Heading.\n[A link](https://example.com)"))
        assertTrue(markdownWithCitations("Fact[^1]\n\n[^1]: Source").toString().isNotEmpty())
        assertTrue(tokenizeCode("val x = 1 // note", "kotlin").isNotEmpty())
    }
}
