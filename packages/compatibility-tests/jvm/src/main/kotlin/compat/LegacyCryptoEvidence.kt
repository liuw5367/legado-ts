package compat

import com.google.gson.JsonObject
import io.legado.app.help.CorpusJsEncodeUtils

internal fun legacyCryptoEvidence(input: JsonObject): Any {
    fun text(key: String) = input.get(key).asString
    fun unsigned(bytes: ByteArray?) = bytes?.map { it.toInt() and 0xff }
    val key = text("key")
    val iv = text("iv")
    val plaintext = text("plaintext")
    val transformation = "AES/CBC/PKCS5Padding"
    return when (text("kind")) {
        "legacy" -> mapOf(
            "plaintext" to CorpusJsEncodeUtils.aesEncodeToString(text("ciphertext"), key, transformation, iv),
            "base64Bytes" to unsigned(CorpusJsEncodeUtils.aesEncodeToBase64ByteArray(plaintext, key, transformation, iv)),
        )
        "factory" -> {
            val first = CorpusJsEncodeUtils.createSymmetricCrypto(transformation, key, iv)
            val second = CorpusJsEncodeUtils.createSymmetricCrypto(transformation, key, iv)
            val original = first.encrypt(plaintext)
            val changed = first.setIv(text("changedIv").encodeToByteArray())
            val updated = first.encrypt(plaintext)
            mapOf(
                "first" to unsigned(original),
                "second" to unsigned(updated),
                "independent" to unsigned(second.encrypt(plaintext)),
                "decrypted" to first.decryptStr(updated),
                "sameInstance" to (changed === first),
            )
        }
        else -> throw Unsupported("未知加密兼容案例")
    }
}
