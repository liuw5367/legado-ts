package compat

import com.google.gson.JsonObject
import io.legado.app.help.CorpusJsExtensions
import io.legado.app.model.analyzeRule.QueryTTF
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.KeyFactory
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
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
    val keyFactory = KeyFactory.getInstance("RSA", provider)
    val key = keyFactory.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(text("privateKey"))))
    val cipher = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding", provider)
    val spec = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec(text("mgf")), PSource.PSpecified.DEFAULT)
    cipher.init(Cipher.DECRYPT_MODE, key, spec)
    val plaintext = cipher.doFinal(Base64.getDecoder().decode(text("ciphertext"))).decodeToString()
    val result = mutableMapOf("status" to "success", "plaintext" to plaintext)
    if (input.has("publicKey") && input.has("label") && input.has("roundtripPlaintext")) {
        val publicKey = keyFactory.generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(text("publicKey"))))
        val labeledSpec = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec(text("mgf")), PSource.PSpecified(text("label").toByteArray(Charsets.UTF_8)))
        cipher.init(Cipher.ENCRYPT_MODE, publicKey, labeledSpec)
        val encrypted = cipher.doFinal(text("roundtripPlaintext").toByteArray(Charsets.UTF_8))
        cipher.init(Cipher.DECRYPT_MODE, key, labeledSpec)
        result["roundtripPlaintext"] = cipher.doFinal(encrypted).decodeToString()
    }
    return result
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
