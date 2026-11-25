package dev.rei.android.feature.settings

import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Pure rules of the Providers pages (chat connections, embeddings, web search), kept apart from the screens so they can be
 * tested. They follow the web's Providers pages; the gateway validates everything again on save. Keys and tokens only ever
 * pass through these functions on their way into a request body: nothing here stores or formats one for display.
 */

/** A saved chat connection (`GET /api/providers`). The key is never part of it. */
internal data class ProviderRow(
    val id: String,
    val name: String,
    val kind: String,
    val auth: String,
    val connected: Boolean,
    val baseUrl: String?,
    val api: String,
    val models: List<String>,
)

internal const val KindOpenAi = "openai"
internal const val KindCustom = "openai-compatible"
internal const val AuthOAuth = "oauth"
internal const val AuthApiKey = "api_key"

internal fun JsonObject.provider() = ProviderRow(
    string("id"), string("name"), string("kind"), optionalString("auth") ?: AuthApiKey,
    optionalString("connected") == "true", optionalString("baseUrl"), optionalString("api") ?: "chat",
    (this["models"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content },
)

internal fun providerRows(body: JsonObject): List<ProviderRow> = body.objects("connections").map { it.provider() }

internal fun providerSubtitle(row: ProviderRow): String =
    if (row.kind == KindCustom) row.baseUrl.orEmpty() else "OpenAI · ${if (row.auth == AuthOAuth) "ChatGPT" else "API key"}"

/** What the provider form holds. [apiKey] is typed text and is cleared after a save. */
internal data class ProviderForm(
    val editingId: String? = null,
    val originalAuth: String? = null,
    val kind: String = KindOpenAi,
    val name: String = "OpenAI",
    val auth: String = AuthOAuth,
    val baseUrl: String = "",
    val api: String = "chat",
    val apiKey: String = "",
    val models: List<String> = emptyList(),
    /** Limits the endpoint reported on the last scan; saved with the model ids so the gateway keeps them. */
    val modelInfo: JsonObject? = null,
)

internal fun newProviderForm(kind: String) = ProviderForm(
    kind = kind,
    name = if (kind == KindOpenAi) "OpenAI" else "My endpoint",
    auth = if (kind == KindOpenAi) AuthOAuth else AuthApiKey,
)

internal fun editProviderForm(row: ProviderRow) = ProviderForm(
    editingId = row.id, originalAuth = row.auth, kind = row.kind, name = row.name, auth = row.auth,
    baseUrl = row.baseUrl.orEmpty(), api = row.api, models = row.models,
)

/** ChatGPT sign-in saves through its own flow, so the form has no Save button in that mode. */
internal fun ProviderForm.usesOAuth() = kind == KindOpenAi && auth == AuthOAuth

internal sealed interface ProviderSave {
    data class Invalid(val message: String) : ProviderSave
    data class Ready(val body: JsonObject) : ProviderSave
}

internal const val MaxProviderName = 80

/** The body of `POST /api/providers`, or the sentence for the first thing missing. A blank key is left out: the gateway keeps the saved one. */
internal fun providerSave(form: ProviderForm): ProviderSave {
    val name = form.name.trim()
    if (name.isEmpty()) return ProviderSave.Invalid("Enter a name for this connection.")
    if (name.length > MaxProviderName) return ProviderSave.Invalid("The name can be at most $MaxProviderName characters.")
    val key = form.apiKey.trim()
    if (form.kind == KindOpenAi && form.auth == AuthApiKey && key.isEmpty() && !(form.editingId != null && form.originalAuth == AuthApiKey)) {
        return ProviderSave.Invalid("Enter your OpenAI API key.")
    }
    val baseUrl = form.baseUrl.trim()
    if (form.kind == KindCustom && baseUrl.isEmpty()) return ProviderSave.Invalid("Enter the endpoint's base URL.")
    return ProviderSave.Ready(buildJsonObject {
        form.editingId?.let { put("id", it) }
        put("name", name)
        put("kind", form.kind)
        if (form.kind == KindOpenAi) put("auth", form.auth)
        if (key.isNotEmpty()) put("apiKey", key)
        if (form.kind == KindCustom) {
            put("baseUrl", baseUrl)
            put("api", form.api)
            put("models", buildJsonArray { form.models.forEach { add(JsonPrimitive(it)) } })
            form.modelInfo?.let { put("modelInfo", it) }
        }
    })
}

/** Adds a model id the user typed: trimmed, no duplicates, none blank. */
internal fun addModelId(models: List<String>, text: String): List<String> {
    val id = text.trim()
    return if (id.isEmpty() || id in models) models else models + id
}

/** The scan request: the URL, the saved connection's id when editing, and a key only if one was typed. */
internal fun scanBody(form: ProviderForm): JsonObject = buildJsonObject {
    put("baseUrl", form.baseUrl.trim())
    form.editingId?.let { put("id", it) }
    form.apiKey.trim().takeIf { it.isNotEmpty() }?.let { put("apiKey", it) }
}

internal fun scanSummary(models: List<String>): String =
    if (models.isEmpty()) "No models found." else "Found ${models.size} model${if (models.size == 1) "" else "s"}. Review the IDs before saving."

/** The sentence for models a save removed from the list, or null. */
internal fun replacedNotice(saved: JsonObject): String? {
    val replaced = (saved["replacedModels"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
    if (replaced.isEmpty()) return null
    val from = replaced.joinToString(", ") { it.string("from") }
    val to = replaced.first().string("to")
    val plural = replaced.size != 1
    return "$from ${if (plural) "were" else "was"} removed from the list, so agents and defaults that used ${if (plural) "them" else "it"} now use $to."
}

// ---- ChatGPT sign-in ------------------------------------------------------------------------------------------------

/** `GET /api/providers/openai/oauth/status`. */
internal data class OAuthStatus(val pending: Boolean, val authorizationUrl: String?, val error: String?)

internal fun oauthStatus(body: JsonObject) = OAuthStatus(
    body.optionalString("pending") == "true", body.optionalString("authorizationUrl"), body.optionalString("error"),
)

/** An address pasted as the redirect: trimmed and not empty; the gateway checks what it says. */
internal fun redirectUrlOrNull(text: String): String? = text.trim().takeIf { it.isNotEmpty() }

// ---- embeddings -----------------------------------------------------------------------------------------------------

internal const val EmbedOff = "off"
internal const val EmbedOmlx = "omlx"
internal const val EmbedOpenAi = "openai"

/** The model profile the oMLX option fills in, mirrored from the web's embedding page. */
internal val OmlxProfile: JsonObject = buildJsonObject {
    put("id", "mlx-community/embeddinggemma-2-6bit")
    put("repository", "mlx-community/embeddinggemma-2-6bit")
    put("revision", "a61f0b6dcee35cf68475e91b8b28ed830057d7c4")
    put("quant", "affine-6bit-g64-bf16")
    put("dims", 768)
    put("pooling", "mean")
    put("docTemplate", "title: none | text: \${t}")
    put("queryTemplate", "task: search result | query: \${q}")
    put("maxInputTokens", 2048)
    put("contextTokens", 2048)
}

internal const val OmlxDefaultUrl = "http://host.docker.internal:18000"
internal const val DefaultDocTemplate = "\${t}"
internal const val DefaultQueryTemplate = "\${q}"
internal const val DefaultContextTokens = 512L

internal data class EmbeddingForm(
    val provider: String = EmbedOff,
    val baseUrl: String = "",
    val apiModel: String = "",
    /** The profile the server holds; any edit drops it so a stale one is never saved. */
    val profile: JsonObject? = null,
    val docTemplate: String = DefaultDocTemplate,
    val queryTemplate: String = DefaultQueryTemplate,
    val contextTokens: String = DefaultContextTokens.toString(),
    val apiKey: String = "",
)

/** The form the server's setup makes; an empty or missing document is "off". */
internal fun embeddingForm(setup: JsonObject): EmbeddingForm {
    val profile = setup["profile"] as? JsonObject
    return EmbeddingForm(
        provider = setup.optionalString("provider") ?: EmbedOff,
        baseUrl = setup.optionalString("baseUrl").orEmpty(),
        apiModel = setup.optionalString("apiModel").orEmpty(),
        profile = profile,
        docTemplate = profile?.optionalString("docTemplate") ?: DefaultDocTemplate,
        queryTemplate = profile?.optionalString("queryTemplate") ?: DefaultQueryTemplate,
        contextTokens = profile?.optionalString("contextTokens") ?: DefaultContextTokens.toString(),
    )
}

/** Choosing a provider: oMLX fills its model id and a default URL; every edit clears the profile and the test result upstream. */
internal fun EmbeddingForm.withProvider(provider: String): EmbeddingForm =
    if (provider == EmbedOmlx) copy(provider = provider, profile = null, apiModel = OmlxProfile.string("id"), baseUrl = baseUrl.ifEmpty { OmlxDefaultUrl })
    else copy(provider = provider, profile = null)

internal fun EmbeddingForm.needsTest() = provider != EmbedOff

internal fun EmbeddingForm.canTest() = needsTest() && baseUrl.isNotBlank() && apiModel.isNotBlank()

/** The body both the connection test and the save send: exactly what the form says. Null when the context limit is not a positive whole number. */
internal fun embeddingBody(form: EmbeddingForm): JsonObject? {
    val contextTokens = parseWholeNumber(form.contextTokens, 1, 10_000_000)
    if (form.provider == EmbedOpenAi && contextTokens == null) return null
    val profile: JsonElement = when (form.provider) {
        EmbedOff -> JsonNull
        EmbedOmlx -> OmlxProfile
        else -> form.profile ?: JsonNull
    }
    return buildJsonObject {
        put("provider", form.provider)
        put("baseUrl", form.baseUrl.trim())
        put("apiModel", form.apiModel.trim())
        put("profile", profile)
        if (form.provider == EmbedOpenAi) put("advanced", buildJsonObject {
            put("docTemplate", form.docTemplate)
            put("queryTemplate", form.queryTemplate)
            put("contextTokens", contextTokens!!)
        })
        form.apiKey.trim().takeIf { it.isNotEmpty() }?.let { put("apiKey", it) }
    }
}

// ---- web search -----------------------------------------------------------------------------------------------------

internal val SearchProviderIds = listOf("codex-subscription", "exa", "exa-api", "brave", "tavily", "searxng")
internal const val DefaultSearchModel = "gpt-6-luna"
internal const val ExaApiRow = "exa-api"

internal fun searchName(option: String): String = when (option) {
    "codex-subscription" -> "ChatGPT / Codex"
    "exa" -> "Exa (keyless)"
    ExaApiRow -> "Exa (API key)"
    "brave" -> "Brave"
    "tavily" -> "Tavily"
    else -> "SearXNG"
}

/** The saved order with every known provider present once; unknown ids are kept out. */
internal fun searchOrder(saved: List<String>): List<String> = (saved + SearchProviderIds).filter { it in SearchProviderIds }.distinct()

/** Moves one provider in the search order. */
internal fun moveSearch(order: List<String>, id: String, delta: Int): List<String> {
    val index = order.indexOf(id)
    val destination = index + delta
    if (index < 0 || destination !in order.indices) return order
    return order.toMutableList().also { it.removeAt(index); it.add(destination, id) }
}

internal data class SearchStatus(val id: String, val configured: Boolean, val limitedUntil: Long?, val lastError: String?)

internal fun searchStatuses(settings: JsonObject): List<SearchStatus> =
    (settings["providerStatus"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.map {
        SearchStatus(it.string("id"), it.optionalString("configured") == "true", it.optionalString("limitedUntil")?.toLongOrNull(), it.optionalString("lastError"))
    }

internal fun searchState(configured: Boolean, status: SearchStatus?, now: Long): String = when {
    !configured -> "Needs setup"
    status?.limitedUntil != null && status.limitedUntil > now -> "Rate limited"
    status?.lastError != null -> "Last attempt failed"
    else -> "Configured"
}

internal data class SearchForm(
    val providers: List<String>,
    val order: List<String>,
    val searxngUrl: String,
    val codexModel: String,
    /** Typed keys by provider; write-only, cleared after a save. */
    val keys: Map<String, String> = emptyMap(),
)

internal fun searchForm(settings: JsonObject) = SearchForm(
    providers = (settings["providers"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content },
    order = searchOrder((settings["providerOrder"] as? JsonArray ?: settings["providers"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content }),
    searxngUrl = settings.optionalString("searxngUrl").orEmpty(),
    codexModel = settings.optionalString("codexModel") ?: DefaultSearchModel,
)

internal fun SearchForm.toggled(id: String, on: Boolean): SearchForm =
    copy(providers = if (on) (providers + id).distinct() else providers - id)

internal sealed interface SearchSave {
    data class Invalid(val message: String) : SearchSave
    data class Ready(val body: JsonObject) : SearchSave
}

internal fun searchSave(form: SearchForm): SearchSave {
    val model = form.codexModel.trim()
    if (!isSearchModelId(model)) return SearchSave.Invalid("The search model can use letters, digits, dots, dashes and underscores, up to 100 characters.")
    val typed = form.keys.mapValues { it.value.trim() }.filterValues { it.isNotEmpty() }
    return SearchSave.Ready(buildJsonObject {
        put("providers", buildJsonArray { form.order.filter { it in form.providers }.forEach { add(JsonPrimitive(it)) } })
        put("providerOrder", buildJsonArray { form.order.forEach { add(JsonPrimitive(it)) } })
        put("searxngUrl", form.searxngUrl.trim())
        put("codexModel", model)
        if (typed.isNotEmpty()) put("apiKeys", buildJsonObject { typed.forEach { (id, key) -> put(id, key) } })
    })
}

/** The first enabled, configured, not rate-limited provider in order: the one a search tries first. */
internal fun firstReady(form: SearchForm, statuses: List<SearchStatus>, now: Long): String? =
    form.order.firstOrNull { id ->
        id in form.providers && statuses.any { it.id == id && it.configured && !(it.limitedUntil != null && it.limitedUntil > now) }
    }
