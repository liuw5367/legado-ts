package compat

import com.google.gson.JsonObject
import io.legado.app.help.CorpusJsExtensions
import io.legado.app.lib.icu4j.CharsetDetector
import java.io.IOException
import java.nio.charset.Charset
import java.util.Base64

internal fun zipDownloadEvidence(input: JsonObject): Any {
    fun text(key: String) = input.get(key).asString
    val transportFailed = text("kind") == "transport-failure"
    val hex = input.get("hex")?.asBoolean == true
    val binary = input.get("binary")?.asBoolean == true
    val result = runCatching {
        if (transportFailed) throw IOException("离线下载失败")
        val bytes = CorpusJsExtensions.zipBytes(Base64.getDecoder().decode(text("archive")), text("path"))
        if (binary) bytes?.map { it.toInt() and 0xff } else if (bytes == null) "" else String(bytes, Charset.forName(CharsetDetector().setText(bytes).detect()?.name ?: "UTF-8"))
    }
    return mapOf(
        "text" to result.getOrNull(),
        "status" to if (result.isSuccess) "success" else "failed",
        "requests" to if (hex) emptyList() else listOf(mapOf(
            "method" to "GET", "url" to text("url"), "authorization" to text("authorization"),
            "followRedirects" to true, "finalUrl" to if (transportFailed) null else text("finalUrl"),
        )),
        "remainingFiles" to emptyList<String>(),
    )
}
