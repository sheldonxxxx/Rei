package dev.rei.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class SavedConnection(val serverUrl: String, val token: String?)

class CredentialStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "rei-connection"))

    fun load(): SavedConnection? {
        return runCatching {
            val encrypted = file.readFully()
            check(encrypted.size > IvBytes)
            val key = keyStore().getKey(KeyAlias, null) as SecretKey
            val plaintext = Cipher.getInstance(Transformation).run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TagBits, encrypted, 0, IvBytes))
                doFinal(encrypted, IvBytes, encrypted.size - IvBytes)
            }
            val connection = Json.parseToJsonElement(plaintext.decodeToString()).jsonObject
            SavedConnection(connection.string("serverUrl"), connection.optionalString("token"))
        }.getOrNull()
    }

    fun save(serverUrl: String, token: String?) {
        val normalized = ReiApi(serverUrl).serverUrl
        val plaintext = buildJsonObject {
            put("serverUrl", normalized)
            if (token != null) put("token", token)
        }.toString().encodeToByteArray()
        val encrypted = Cipher.getInstance(Transformation).run {
            init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            check(iv.size == IvBytes)
            iv + doFinal(plaintext)
        }
        val output = file.startWrite()
        try {
            output.write(encrypted)
            file.finishWrite(output)
        } catch (failure: Exception) {
            file.failWrite(output)
            throw failure
        }
    }

    fun clear() {
        file.delete()
    }

    private fun keyStore() = KeyStore.getInstance(Keystore).apply { load(null) }

    private fun getOrCreateKey(): SecretKey {
        (keyStore().getKey(KeyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, Keystore).run {
            init(
                KeyGenParameterSpec.Builder(
                    KeyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val Keystore = "AndroidKeyStore"
        const val KeyAlias = "rei-connection"
        const val Transformation = "AES/GCM/NoPadding"
        const val IvBytes = 12
        const val TagBits = 128
    }
}
