package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.htmlunit.corejs.javascript.Context
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
        when {
            input.get("observeScriptBytes")?.asBoolean == true -> Context.enter().use { engine ->
                val scope = engine.initSafeStandardObjects()
                scope.put("bytes", scope, Context.javaToJS(requireNotNull(bytes), scope))
                val script = """
                    JSON.stringify({
                      indexed: [bytes[0], bytes[1], bytes[2], bytes[3]],
                      list: Array.from(bytes),
                      hex: Array.from(bytes, n => (n & 255).toString(16).padStart(2, "0")).join("")
                    })
                """.trimIndent()
                JsonParser.parseString(Context.toString(engine.evaluateString(scope, script, "zip-byte-fixture", 1, null)))
            }
            binary -> bytes?.map { it.toInt() and 0xff }
            bytes == null -> ""
            else -> String(bytes, Charset.forName(CharsetDetector().setText(bytes).detect()?.name ?: "UTF-8"))
        }
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
