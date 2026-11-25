package dev.rei.android

import android.app.Activity
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import dev.rei.android.data.ReiApi
import dev.rei.android.data.ReiApiException
import dev.rei.android.data.obj
import dev.rei.android.data.string
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

internal val passkeyPath = listOf("api", "auth", "passkeys")

internal suspend fun authenticateWithPasskey(
    activity: Activity,
    api: ReiApi,
    deviceLabel: String,
): String? {
    val start = api.request("POST", passkeyPath + listOf("login", "options"))
    val request = GetCredentialRequest(
        credentialOptions = listOf(GetPublicKeyCredentialOption(start.obj("options").toString())),
    )
    val credential = try {
        CredentialManager.create(activity).getCredential(context = activity, request = request).credential
    } catch (_: GetCredentialCancellationException) {
        return null
    } catch (_: NoCredentialException) {
        throw IllegalStateException(activity.getString(R.string.passkey_err_none))
    } catch (_: GetCredentialException) {
        throw IllegalStateException(activity.getString(R.string.passkey_err_use))
    }
    check(credential is PublicKeyCredential) { activity.getString(R.string.passkey_err_not_returned) }
    val signedIn = api.request("POST", passkeyPath + "login", buildJsonObject {
        put("challengeId", start.string("challengeId"))
        put("response", Json.parseToJsonElement(credential.authenticationResponseJson).jsonObject)
        put("deviceLabel", deviceLabel)
    })
    return signedIn.string("token")
}

internal suspend fun registerPasskey(activity: Activity, api: ReiApi, password: String, label: String): Boolean {
    val start = api.request("POST", passkeyPath + listOf("register", "options"), buildJsonObject {
        put("password", password)
    })
    val request = CreatePublicKeyCredentialRequest(start.obj("options").toString())
    val created = try {
        CredentialManager.create(activity).createCredential(context = activity, request = request)
    } catch (_: CreateCredentialCancellationException) {
        return false
    } catch (_: CreateCredentialException) {
        throw IllegalStateException(activity.getString(R.string.passkey_err_create))
    }
    check(created is CreatePublicKeyCredentialResponse) { activity.getString(R.string.passkey_err_not_returned) }
    api.request("POST", passkeyPath + "register", buildJsonObject {
        put("challengeId", start.string("challengeId"))
        put("response", Json.parseToJsonElement(created.registrationResponseJson).jsonObject)
        if (label.isNotBlank()) put("label", label)
    })
    return true
}

internal fun passkeyError(context: android.content.Context, failure: Exception): String = when (failure) {
    is ReiApiException, is IllegalStateException -> failure.message ?: context.getString(R.string.passkey_err_update)
    else -> context.getString(R.string.passkey_err_update)
}
