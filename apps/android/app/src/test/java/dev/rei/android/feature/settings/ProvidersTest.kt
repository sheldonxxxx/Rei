package dev.rei.android.feature.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProvidersTest {
    private fun ready(save: ProviderSave) = (save as ProviderSave.Ready).body

    @Test
    fun openAiApiKeyIsRequiredUnlessKeepingTheSavedOne() {
        val add = newProviderForm(KindOpenAi).copy(auth = AuthApiKey)
        assertTrue(providerSave(add) is ProviderSave.Invalid)
        val body = ready(providerSave(add.copy(apiKey = " sk-test ")))
        assertEquals(JsonPrimitive("sk-test"), body["apiKey"])
        assertEquals(JsonPrimitive(AuthApiKey), body["auth"])
        val edit = add.copy(editingId = "p1", originalAuth = AuthApiKey)
        val kept = ready(providerSave(edit))
        assertFalse(kept.containsKey("apiKey"))
        assertEquals(JsonPrimitive("p1"), kept["id"])
        // Switching an OAuth connection to a key needs one.
        assertTrue(providerSave(edit.copy(originalAuth = AuthOAuth)) is ProviderSave.Invalid)
    }

    @Test
    fun customEndpointBodyCarriesUrlApiModelsAndLimits() {
        val info = buildJsonObject { put("m1", buildJsonObject { put("contextWindow", 8000) }) }
        val form = newProviderForm(KindCustom).copy(baseUrl = " https://x.test/v1 ", api = "responses", models = listOf("m1"), modelInfo = info)
        val body = ready(providerSave(form))
        assertEquals(JsonPrimitive("https://x.test/v1"), body["baseUrl"])
        assertEquals(JsonPrimitive("responses"), body["api"])
        assertEquals(buildJsonArray { add(JsonPrimitive("m1")) }, body["models"])
        assertEquals(info, body["modelInfo"])
        assertFalse(body.containsKey("auth"))
        assertFalse(body.containsKey("apiKey"))
        assertTrue(providerSave(form.copy(baseUrl = " ")) is ProviderSave.Invalid)
        assertTrue(providerSave(form.copy(name = " ")) is ProviderSave.Invalid)
    }

    @Test
    fun scanSendsAKeyOnlyWhenTyped() {
        val form = newProviderForm(KindCustom).copy(baseUrl = "https://x.test", editingId = "p1")
        assertEquals(setOf("baseUrl", "id"), scanBody(form).keys)
        assertEquals(setOf("baseUrl", "id", "apiKey"), scanBody(form.copy(apiKey = "k")).keys)
        assertEquals("No models found.", scanSummary(emptyList()))
        assertEquals("Found 1 model. Review the IDs before saving.", scanSummary(listOf("a")))
    }

    @Test
    fun modelIdsAreTrimmedAndUnique() {
        assertEquals(listOf("a", "b"), addModelId(listOf("a"), " b "))
        assertEquals(listOf("a"), addModelId(listOf("a"), "a"))
        assertEquals(listOf("a"), addModelId(listOf("a"), "  "))
    }

    @Test
    fun replacedModelsReadAsOneSentence() {
        val saved = buildJsonObject {
            put("replacedModels", buildJsonArray { add(buildJsonObject { put("from", "a/x"); put("to", "b/y") }) })
        }
        assertEquals("a/x was removed from the list, so agents and defaults that used it now use b/y.", replacedNotice(saved))
        assertNull(replacedNotice(buildJsonObject { }))
    }

    @Test
    fun rowsAndStatusRead() {
        val row = buildJsonObject {
            put("id", "p1"); put("name", "Local"); put("kind", KindCustom); put("auth", AuthApiKey); put("connected", true)
            put("baseUrl", "http://localhost:8080/v1"); put("models", buildJsonArray { add(JsonPrimitive("m")) })
        }.provider()
        assertEquals("http://localhost:8080/v1", providerSubtitle(row))
        assertEquals("chat", row.api)
        assertEquals("OpenAI · ChatGPT", providerSubtitle(row.copy(kind = KindOpenAi, auth = AuthOAuth)))
        val status = oauthStatus(buildJsonObject { put("pending", true); put("authorizationUrl", "https://auth.test/x") })
        assertTrue(status.pending)
        assertNull(status.error)
        assertNull(redirectUrlOrNull("  "))
    }

    @Test
    fun embeddingBodyFollowsTheProvider() {
        val off = embeddingBody(EmbeddingForm())!!
        assertEquals(JsonNull, off["profile"])
        val omlx = EmbeddingForm().withProvider(EmbedOmlx)
        assertEquals(OmlxDefaultUrl, omlx.baseUrl)
        assertEquals("mlx-community/embeddinggemma-2-6bit", omlx.apiModel)
        assertEquals(OmlxProfile, embeddingBody(omlx)!!["profile"])
        val openai = EmbeddingForm(provider = EmbedOpenAi, baseUrl = "https://x.test", apiModel = "m", contextTokens = "1024", apiKey = " k ")
        val body = embeddingBody(openai)!!
        assertEquals(JsonPrimitive("k"), body["apiKey"])
        assertEquals(JsonPrimitive(1024L), (body["advanced"] as JsonObject)["contextTokens"])
        assertNull(embeddingBody(openai.copy(contextTokens = "")))
        assertTrue(openai.canTest())
        assertFalse(EmbeddingForm().canTest())
    }

    @Test
    fun embeddingFormReadsAServerSetupOrNothing() {
        assertEquals(EmbedOff, embeddingForm(JsonObject(emptyMap())).provider)
        val setup = buildJsonObject {
            put("provider", EmbedOpenAi); put("baseUrl", "https://x.test"); put("apiModel", "m")
            put("profile", buildJsonObject { put("docTemplate", "d \${t}"); put("queryTemplate", "q \${q}"); put("contextTokens", 2048) })
        }
        val form = embeddingForm(setup)
        assertEquals("2048", form.contextTokens)
        assertEquals("d \${t}", form.docTemplate)
    }

    @Test
    fun searchOrderFillsInAndExaShowsTwice() {
        assertEquals(listOf("brave", "codex-subscription", "exa", "tavily", "searxng"), searchOrder(listOf("brave", "bogus")))
        assertEquals(listOf("exa", "exa-api"), searchRows(listOf("exa")))
    }

    @Test
    fun movingRowsReordersProviders() {
        val order = listOf("codex-subscription", "exa", "brave", "tavily", "searxng")
        assertEquals(listOf("exa", "codex-subscription", "brave", "tavily", "searxng"), moveSearch(order, "codex-subscription", 1))
        assertEquals(listOf("codex-subscription", "brave", "exa", "tavily", "searxng"), moveSearch(order, "exa-api", 1))
        assertEquals(order, moveSearch(order, "codex-subscription", -1))
        assertEquals(order, moveSearch(order, "searxng", 1))
    }

    @Test
    fun togglingExaPicksItsSignInKind() {
        val form = SearchForm(providers = emptyList(), order = SearchProviderIds, searxngUrl = "", exaAuth = "keyless", codexModel = DefaultSearchModel)
        val api = form.toggled("exa-api", true)
        assertEquals("api_key", api.exaAuth)
        assertTrue(api.enabled("exa-api"))
        assertFalse(api.enabled("exa"))
        assertFalse(api.toggled("exa-api", false).enabled("exa-api"))
    }

    @Test
    fun searchSaveKeepsOrderEnabledAndOnlyTypedKeys() {
        val form = SearchForm(
            providers = listOf("brave", "tavily"), order = listOf("tavily", "brave", "exa", "codex-subscription", "searxng"),
            searxngUrl = " https://s.test ", exaAuth = "keyless", codexModel = DefaultSearchModel,
            keys = mapOf("brave" to " key ", "tavily" to " "),
        )
        val body = (searchSave(form) as SearchSave.Ready).body
        assertEquals(JsonArray(listOf(JsonPrimitive("tavily"), JsonPrimitive("brave"))), body["providers"])
        assertEquals(setOf("brave"), (body["apiKeys"] as JsonObject).keys)
        assertEquals(JsonPrimitive("key"), (body["apiKeys"] as JsonObject)["brave"])
        assertEquals(JsonPrimitive("https://s.test"), body["searxngUrl"])
        assertFalse((searchSave(form.copy(keys = emptyMap())) as SearchSave.Ready).body.containsKey("apiKeys"))
        assertTrue(searchSave(form.copy(codexModel = "bad model!")) is SearchSave.Invalid)
    }

    @Test
    fun firstReadySkipsUnconfiguredAndLimited() {
        val form = SearchForm(listOf("exa", "brave"), listOf("codex-subscription", "exa", "brave", "tavily", "searxng"), "", "keyless", DefaultSearchModel)
        val statuses = listOf(SearchStatus("exa", true, 2_000, null), SearchStatus("brave", true, null, null))
        assertEquals("brave", firstReady(form, statuses, now = 1_000))
        assertEquals("exa", firstReady(form, statuses, now = 3_000))
        assertEquals("Rate limited", searchState(true, statuses[0], 1_000))
        assertEquals("Needs setup", searchState(false, null, 0))
        assertEquals("Last attempt failed", searchState(true, SearchStatus("x", true, null, "boom"), 0))
    }
}
