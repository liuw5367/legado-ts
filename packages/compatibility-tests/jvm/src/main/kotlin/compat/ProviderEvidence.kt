package compat

import com.google.gson.JsonObject
import io.legado.app.help.CorpusJsExtensions
import io.legado.app.model.analyzeRule.QueryTTF
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyFactory
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.HexFormat
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

internal fun providerCryptoEvidence(input: JsonObject): Any {
    fun text(key: String) = input.get(key).asString
    fun hex(key: String) = HexFormat.of().parseHex(text(key))
    val provider = BouncyCastleProvider()
    if (text("kind") == "gcm") {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding", provider)
        val key = SecretKeySpec(hex("key"), "AES")
        val iv = GCMParameterSpec(128, hex("iv"))
        val aad = text("aad").encodeToByteArray()
        cipher.init(Cipher.ENCRYPT_MODE, key, iv)
        cipher.updateAAD(aad)
        val encrypted = cipher.doFinal(text("plaintext").encodeToByteArray())
        fun decrypt(associated: ByteArray): String {
            cipher.init(Cipher.DECRYPT_MODE, key, iv)
            cipher.updateAAD(associated)
            return cipher.doFinal(encrypted).decodeToString()
        }
        return mapOf("ciphertext" to HexFormat.of().formatHex(encrypted), "plaintext" to decrypt(aad),
            "rejectsWrongAad" to (runCatching { decrypt("wrong".encodeToByteArray()) }.exceptionOrNull() is AEADBadTagException))
    }
    val key = KeyFactory.getInstance("RSA", provider).generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(text("privateKey"))))
    val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding", provider)
    val spec = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec(text("mgf")), PSource.PSpecified.DEFAULT)
    cipher.init(Cipher.DECRYPT_MODE, key, spec)
    return mapOf("status" to "success", "plaintext" to cipher.doFinal(Base64.getDecoder().decode(text("ciphertext"))).decodeToString())
}

internal fun fontEvidence(input: JsonObject): Any {
    fun font(key: String) = QueryTTF(Base64.getDecoder().decode(input.get(key).asString))
    val error = font("errorFont")
    val correct = font("correctFont")
    val point = input.get("point").asInt
    val missing = input.get("missing").asInt
    val glyph = error.getGlyfByUnicode(point)
    val text = input.get("text").asString
    return mapOf("id" to error.getGlyfIdByUnicode(point), "glyph" to glyph, "byId" to error.getGlyfById(error.getGlyfIdByUnicode(point)),
        "missingId" to error.getGlyfIdByUnicode(missing), "missingGlyph" to error.getGlyfByUnicode(missing),
        "mapped" to correct.getUnicodeByGlyf(glyph), "preserved" to CorpusJsExtensions.replaceFont(text, error, correct, false),
        "filtered" to CorpusJsExtensions.replaceFont(text, error, correct, true))
}
