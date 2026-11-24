package dev.rei.android.feature.settings

import androidx.annotation.StringRes
import dev.rei.android.R
import dev.rei.android.data.objects
import dev.rei.android.data.optionalString
import dev.rei.android.data.string
import dev.rei.android.ui.UiText
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI

/**
 * Pure rules for the Connectors pages, following the web's: how a connector reads, how a name is guessed from an address, how
 * a tool's class changes, and how the address a provider's sign-in ends on is taken apart. Tokens and sign-in codes pass
 * through here only on their way into a request; nothing here keeps or shows one.
 */

internal data class Connector(
    val id: String,
    val name: String,
    val url: String,
    val auth: String,
    val tokenHeader: String?,
    val status: String,
    val error: String?,
    val toolCount: Long?,
    val holdsPrivate: Boolean,
    val mcpProfile: String?,
    val mcpProfileRevision: String?,
    val providerIdentity: String?,
    val pluginId: String?,
    val pluginName: String?,
    val pluginEnabled: Boolean,
)

internal fun JsonObject.connector(): Connector {
    val plugin = this["plugin"] as? JsonObject
    return Connector(
        id = string("id"), name = string("name"), url = string("url"), auth = optionalString("auth") ?: "none",
        tokenHeader = optionalString("tokenHeader"), status = optionalString("status") ?: "error", error = optionalString("error"),
        toolCount = optionalString("toolCount")?.toLongOrNull(), holdsPrivate = optionalString("holdsPrivate") != "false",
        mcpProfile = optionalString("mcpProfile"), mcpProfileRevision = optionalString("mcpProfileRevision"),
        providerIdentity = optionalString("providerIdentity"),
        pluginId = plugin?.optionalString("id"), pluginName = plugin?.optionalString("name"),
        pluginEnabled = plugin?.optionalString("enabled") != "false",
    )
}

internal fun connectorList(body: JsonObject): List<Connector> = body.objects("connectors").map { it.connector() }

internal fun addressHost(url: String): String = try {
    URI(url).host?.let { host -> URI(url).port.takeIf { it > 0 }?.let { "$host:$it" } ?: host } ?: url
} catch (_: Exception) {
    url
}

/** A name guessed from the address: `https://mcp.notion.com/mcp` gives "Notion". */
internal fun nameFromUrl(value: String): String {
    val withScheme = if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(value)) value else "https://$value"
    val host = addressHost(withScheme).replace(Regex(":\\d+$"), "")
    val parts = host.split('.').filter { it.isNotEmpty() && !Regex("^(www|mcp|api|app|server)$", RegexOption.IGNORE_CASE).matches(it) }
    val label = if (parts.size >= 2) parts[parts.size - 2] else parts.firstOrNull() ?: host
    return if (label.isEmpty()) host else label.replaceFirstChar { it.uppercase() }
}

internal fun statusWord(status: String): UiText = UiText.Resource(
    when (status) {
        "connected" -> R.string.settings_providers_connected
        "needs_auth" -> R.string.settings_conn_status_needs_auth
        else -> R.string.settings_conn_status_error
    },
)

internal fun statusText(c: Connector): UiText =
    if (c.status == "error" && c.error != null) UiText.Resource(R.string.settings_conn_status_error_msg, c.error)
    else statusWord(c.status)

internal fun toolCountText(count: Long?): UiText = when (count) {
    null -> UiText.Resource(R.string.settings_conn_tools_unlisted)
    else -> UiText.Plural(R.plurals.settings_conn_tools_count, count.toInt(), count)
}

/** A catalogued first-party connector the user can set up with one tap. */
internal data class CatalogConnector(val id: String, val name: String, val publisher: String, @StringRes val descriptionRes: Int, val url: String, val docsUrl: String, val preview: Boolean)

internal val ConnectorCatalog = listOf(
    CatalogConnector("notion", "Notion", "Notion", R.string.settings_conn_catalog_notion_desc, "https://mcp.notion.com/mcp", "https://developers.notion.com/guides/mcp/get-started-with-mcp", false),
    CatalogConnector("gmail", "Gmail", "Google", R.string.settings_conn_catalog_gmail_desc, "https://gmailmcp.googleapis.com/mcp/v1", "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server", true),
)

/** The create request for a catalogued connector: its address and name, no token. */
internal fun catalogBody(entry: CatalogConnector): JsonObject = buildJsonObject {
    put("url", entry.url)
    put("name", entry.name)
}

/** The optional trailing slash counts as the same endpoint; a matching name or host alone does not. */
internal fun matchesCatalogUrl(url: String, entry: CatalogConnector): Boolean = try {
    val actual = URI(url)
    val expected = URI(entry.url)
    actual.scheme == expected.scheme && actual.host == expected.host && actual.port == expected.port &&
        actual.path.orEmpty().trimEnd('/') == expected.path && actual.rawQuery == null && actual.fragment == null && actual.userInfo == null
} catch (_: Exception) {
    false
}

internal enum class ToolClass(val wire: String, @StringRes val labelRes: Int) {
    Read("read_external", R.string.chat_trace_class_read_internal),
    Write("write_external", R.string.chat_trace_class_write_internal),
    Send("send", R.string.chat_trace_class_send),
    Irreversible("irreversible", R.string.chat_trace_class_irreversible);

    companion object {
        fun fromWire(value: String?) = entries.firstOrNull { it.wire == value }
    }
}

internal data class ConnectorTool(
    val name: String,
    val description: String,
    val defaultClass: ToolClass,
    val override: ToolClass?,
    val effectiveClass: ToolClass?,
    val fingerprint: String?,
) {
    val current: ToolClass get() = effectiveClass ?: override ?: defaultClass
    /** A tool classified as irreversible cannot be downgraded. */
    val locked: Boolean get() = defaultClass == ToolClass.Irreversible
}

internal fun toolList(body: JsonObject): List<ConnectorTool> = body.objects("tools").map {
    val default = ToolClass.fromWire(it.optionalString("defaultClass")) ?: ToolClass.Write
    ConnectorTool(
        it.string("name"), it.optionalString("description").orEmpty(), default,
        ToolClass.fromWire(it.optionalString("override")), ToolClass.fromWire(it.optionalString("effectiveClass")),
        it.optionalString("definitionFingerprint"),
    )
}

/** Choosing the tool's own default class clears the override. */
internal fun overrideFor(tool: ConnectorTool, chosen: ToolClass): ToolClass? = if (chosen == tool.defaultClass) null else chosen

/** The tool as it reads once [value] is saved, so the list updates without a reload. */
internal fun ConnectorTool.withOverride(value: ToolClass?): ConnectorTool =
    copy(override = value, effectiveClass = if (defaultClass == ToolClass.Irreversible) ToolClass.Irreversible else value ?: defaultClass)

internal fun toolClassBody(tool: ConnectorTool, value: ToolClass?): JsonObject = buildJsonObject {
    put("actionClass", value?.wire?.let(::JsonPrimitive) ?: JsonNull)
    tool.fingerprint?.let { put("definitionFingerprint", it) }
}

internal val McpProfiles = listOf(
    Choice("always_ask", UiText.Resource(R.string.settings_conn_profile_always_ask), UiText.Resource(R.string.settings_conn_profile_always_ask_desc)),
    Choice("read_only", UiText.Resource(R.string.settings_conn_profile_read_only), UiText.Resource(R.string.settings_conn_profile_read_only_desc)),
    Choice("read_write", UiText.Resource(R.string.settings_conn_profile_read_write), UiText.Resource(R.string.settings_conn_profile_read_write_desc)),
    Choice("yolo", UiText.Resource(R.string.chat_profile_yolo), UiText.Resource(R.string.settings_conn_profile_yolo_desc)),
)

internal fun profileBody(profile: String, connector: Connector, confirmed: Boolean): JsonObject = buildJsonObject {
    put("profile", profile)
    put("providerIdentity", connector.providerIdentity.orEmpty())
    put("expectedRevision", connector.mcpProfileRevision.orEmpty())
    if (confirmed) put("confirmYolo", true)
}

/** The profile can change only once the connector has reported who it is and its revision. */
internal fun Connector.canSetProfile() = !providerIdentity.isNullOrEmpty() && !mcpProfileRevision.isNullOrEmpty()

internal sealed interface ConnectorCreate {
    data class Invalid(val message: UiText) : ConnectorCreate
    data class Ready(val body: JsonObject) : ConnectorCreate
}

internal fun connectorCreate(url: String, name: String, token: String, tokenHeader: String): ConnectorCreate {
    val address = url.trim()
    if (address.isEmpty()) return ConnectorCreate.Invalid(UiText.Resource(R.string.settings_conn_err_address))
    if (address.length > 2000) return ConnectorCreate.Invalid(UiText.Resource(R.string.settings_conn_err_address_len))
    val label = name.trim().ifEmpty { addressHost(address) }.take(80)
    return ConnectorCreate.Ready(buildJsonObject {
        put("url", address)
        put("name", label)
        token.trim().takeIf { it.isNotEmpty() }?.let { put("token", it) }
        tokenHeader.trim().takeIf { it.isNotEmpty() }?.let { put("tokenHeader", it) }
    })
}

/** Saving a token connector's authentication: a typed token, and the header only when it changed. Null when nothing changed. */
internal fun authenticationBody(connector: Connector, token: String, tokenHeader: String): JsonObject? {
    val header = tokenHeader.trim()
    val headerChanged = !header.equals(connector.tokenHeader.orEmpty(), ignoreCase = true)
    val typed = token.trim()
    if (typed.isEmpty() && !headerChanged) return null
    return buildJsonObject {
        if (typed.isNotEmpty()) put("token", typed)
        if (headerChanged) put("tokenHeader", header.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive) ?: JsonNull)
    }
}

internal fun clientIdBody(clientId: String, clientSecret: String): JsonObject = buildJsonObject {
    clientId.trim().takeIf { it.isNotEmpty() }?.let { put("clientId", it) }
    if (clientId.isNotBlank()) clientSecret.trim().takeIf { it.isNotEmpty() }?.let { put("clientSecret", it) }
}

/** What a provider's sign-in left in the address it ended on. */
internal sealed interface SignInReturn {
    data class Code(val state: String, val code: String, val iss: String?) : SignInReturn
    data class Failed(val reason: String) : SignInReturn
    data object None : SignInReturn
}

/**
 * Reads the pasted address the sign-in ended on: `…?state=…&code=…` (the web app's page or the server's callback) or a
 * provider error (`oauth_error` or `error`). Anything else is [SignInReturn.None].
 */
internal fun signInReturn(address: String): SignInReturn {
    val query = try { URI(address.trim()).rawQuery } catch (_: Exception) { null } ?: return SignInReturn.None
    val params = query.split('&').filter { it.isNotEmpty() }.associate { pair ->
        val key = pair.substringBefore('=')
        val value = pair.substringAfter('=', "")
        java.net.URLDecoder.decode(key, "UTF-8") to java.net.URLDecoder.decode(value, "UTF-8")
    }
    val state = params["state"]
    val code = params["code"]
    if (!state.isNullOrEmpty() && !code.isNullOrEmpty()) return SignInReturn.Code(state, code, params["iss"]?.takeIf { it.isNotEmpty() })
    val error = params["oauth_error"] ?: params["error"]
    return if (!error.isNullOrEmpty()) SignInReturn.Failed(error) else SignInReturn.None
}

internal fun finishBody(result: SignInReturn.Code): JsonObject = buildJsonObject {
    put("state", result.state)
    put("code", result.code)
    result.iss?.let { put("iss", it) }
}
