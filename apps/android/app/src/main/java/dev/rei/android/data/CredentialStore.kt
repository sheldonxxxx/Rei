package dev.rei.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.AtomicFile
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
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
            // Files written before the AAD was added decrypt without it. They are rewritten with it once read.
            val (plaintext, legacy) = try {
                decrypt(key, encrypted, Aad) to false
            } catch (_: GeneralSecurityException) {
                decrypt(key, encrypted, null) to true
            }
            val connection = Json.parseToJsonElement(plaintext.decodeToString()).jsonObject
            val saved = SavedConnection(connection.string("serverUrl"), connection.optionalString("token"))
            if (legacy) runCatching { save(saved.serverUrl, saved.token) }
            saved
        }.getOrNull()
    }

    fun save(serverUrl: String, token: String?) {
        val normalized = ReiApi(serverUrl).serverUrl
        val plaintext = buildJsonObject {
            put("serverUrl", normalized)
            if (token != null) put("token", token)
        }.toString().encodeToByteArray()
        val encrypted = try {
            encrypt(plaintext)
        } catch (_: GeneralSecurityException) {
            recreateKeyAndEncrypt(plaintext)
        } catch (_: ProviderException) {
            recreateKeyAndEncrypt(plaintext)
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
        deleteKey()
    }

    private fun decrypt(key: SecretKey, encrypted: ByteArray, aad: ByteArray?): ByteArray =
        Cipher.getInstance(Transformation).run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TagBits, encrypted, 0, IvBytes))
            if (aad != null) updateAAD(aad)
            doFinal(encrypted, IvBytes, encrypted.size - IvBytes)
        }

    private fun encrypt(plaintext: ByteArray): ByteArray = Cipher.getInstance(Transformation).run {
        init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        updateAAD(Aad)
        check(iv.size == IvBytes)
        iv + doFinal(plaintext)
    }

    /** A key that was invalidated or corrupted (a lock-screen change, a restored device) is deleted and made again, once. */
    private fun recreateKeyAndEncrypt(plaintext: ByteArray): ByteArray {
        deleteKey()
        return encrypt(plaintext)
    }

    private fun deleteKey() {
        runCatching { keyStore().deleteEntry(KeyAlias) }
    }

    private fun keyStore() = KeyStore.getInstance(Keystore).apply { load(null) }

    private fun getOrCreateKey(): SecretKey {
        (keyStore().getKey(KeyAlias, null) as? SecretKey)?.let { return it }
        return try {
            generateKey(strongBox = true)
        } catch (_: StrongBoxUnavailableException) {
            generateKey(strongBox = false)
        }
    }

    private fun generateKey(strongBox: Boolean): SecretKey =
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, Keystore).run {
            init(
                KeyGenParameterSpec.Builder(
                    KeyAlias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setIsStrongBoxBacked(strongBox)
                    .build(),
            )
            generateKey()
        }

    private companion object {
        const val Keystore = "AndroidKeyStore"
        const val KeyAlias = "rei-connection"
        const val Transformation = "AES/GCM/NoPadding"
        const val IvBytes = 12
        const val TagBits = 128
        /** Binds the ciphertext to this purpose, so it cannot be swapped for another blob sealed with the same key. */
        val Aad = "dev.rei.android:rei-connection:v1".encodeToByteArray()
    }
}
