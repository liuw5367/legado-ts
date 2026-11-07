package compat

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.jayway.jsonpath.Configuration
import com.jayway.jsonpath.JsonPath
import com.jayway.jsonpath.Option
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import io.legado.app.model.analyzeRule.AnalyzeByJSonPath
import io.legado.app.model.analyzeRule.AnalyzeByRegex
import io.legado.app.model.analyzeRule.RuleAnalyzer
import java.net.URL
import java.net.URLEncoder
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Base64
import java.util.regex.Pattern

private val gson = GsonBuilder().serializeNulls().disableHtmlEscaping().create()
private class Unsupported(message: String) : RuntimeException(message)

private fun execute(item: JsonObject): Any? {
    val input = item.getAsJsonObject("input")
    fun text(key: String) = input.get(key)?.asString ?: ""
    return when (val operation = item.get("operation").asString) {
        "rule.split" -> RuleAnalyzer(text("rule"), input.get("code")?.asBoolean ?: false).splitRule(text("operator"))
        "rule.inner" -> RuleAnalyzer(text("rule"), true).innerRule("{$.") { path -> input.getAsJsonObject("values").get(path)?.asString }
        "regex.first" -> AnalyzeByRegex.getElement(text("text"), input.getAsJsonArray("patterns").map { it.asString }.toTypedArray())
        "regex.all" -> AnalyzeByRegex.getElements(text("text"), input.getAsJsonArray("patterns").map { it.asString }.toTypedArray())
        "pattern.split" -> Pattern.compile(text("pattern")).split(text("text"), input.get("limit").asInt).toList()
        "string.split" -> java.lang.String(text("text")).split(text("pattern"), input.get("limit").asInt).toList()
        "string.replaceAll" -> java.lang.String(text("text")).replaceAll(text("pattern"), text("replacement"))
        "string.replaceFirst" -> java.lang.String(text("text")).replaceFirst(text("pattern"), text("replacement"))
        "pattern.quote" -> Pattern.quote(text("text"))
        "integer.parseLong" -> mapOf("type" to "integer", "decimal" to java.lang.Long.parseLong(text("text")).toString())
        "encoding.base64Encode" -> Base64.getEncoder().encodeToString(text("text").toByteArray(Charsets.UTF_8))
        "encoding.base64Decode" -> mapOf("type" to "bytes", "base64" to Base64.getEncoder().encodeToString(Base64.getDecoder().decode(text("text"))))
        "encoding.urlEncode" -> URLEncoder.encode(text("text"), "UTF-8")
        "encoding.urlDecode" -> URLDecoder.decode(text("text"), "UTF-8")
        "encoding.md5" -> MessageDigest.getInstance("MD5").digest(text("text").toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        "url.parts" -> {
            val url = if (input.has("base")) URL(URL(text("base")), text("url")) else URL(text("url"))
            mapOf("protocol" to url.protocol, "host" to url.host, "port" to url.port, "defaultPort" to url.defaultPort,
                "path" to url.path, "file" to url.file, "query" to url.query, "ref" to url.ref,
                "authority" to url.authority, "userInfo" to url.userInfo)
        }
        "css.string" -> AnalyzeByJSoup(text("content")).getString(text("rule"))
        "css.list" -> AnalyzeByJSoup(text("content")).getStringList(text("rule"))
        "json.read" -> JsonPath.using(Configuration.defaultConfiguration().addOptions(Option.ALWAYS_RETURN_LIST)).parse(text("content")).read<Any>(text("rule"))
        "json.string" -> AnalyzeByJSonPath(text("content")).getString(text("rule"))
        "json.list" -> AnalyzeByJSonPath(text("content")).getStringList(text("rule"))
        else -> throw Unsupported("未注册的操作: $operation")
    }
}

fun main() {
    System.setProperty("file.encoding", "UTF-8")
    generateSequence(::readLine).forEach { line ->
        val item = JsonParser.parseString(line).asJsonObject
        val id = item.get("id").asString
        val result = try {
            mapOf("id" to id, "execution" to "completed", "outcome" to "return", "value" to execute(item))
        } catch (error: Unsupported) {
            mapOf("id" to id, "execution" to "unsupported", "reason" to error.message)
        } catch (error: Throwable) {
            // 虚拟机资源故障属于执行器失败，不能伪装成被测函数的业务异常。
            if (error is VirtualMachineError || error is LinkageError) {
                mapOf("id" to id, "execution" to "runner-failed", "reason" to "${error.javaClass.name}: ${error.message}")
            } else {
                mapOf("id" to id, "execution" to "completed", "outcome" to "throw",
                    "error" to mapOf("class" to error.javaClass.name, "message" to (error.message ?: "")))
            }
        }
        // UTF-8 无法编码单独的代理代码单元，必须先写成 JSON Unicode 转义，避免变为问号。
        val json = gson.toJson(result)
        println(buildString {
            json.forEach { char ->
                if (char.code in 0xD800..0xDFFF) append("\\u%04x".format(char.code)) else append(char)
            }
        })
    }
}
