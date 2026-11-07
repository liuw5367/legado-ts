package compat

import com.google.gson.JsonParser
import io.legado.app.utils.FlowFormEncoding
import java.net.URLEncoder

internal data class FlowRequest(
    val url: String,
    val headers: Map<String, String>,
    val method: String = "GET",
    val body: String? = null,
)

internal fun flowSearchRequest(
    rule: String,
    keyword: String,
    headers: Map<String, String>,
    resolve: (String) -> String,
): FlowRequest {
    // AnalyzeUrl.paramPattern 分隔 URL 和选项，静态关键字在解析选项前展开。
    val separator = Regex("\\s*,\\s*(?=\\{)").find(rule)
        ?: return FlowRequest(resolve(rule.replace("{{key}}", URLEncoder.encode(keyword, Charsets.UTF_8))), headers)
    val url = resolve(rule.substring(0, separator.range.first))
    val options = JsonParser.parseString(rule.substring(separator.range.last + 1).replace("{{key}}", keyword)).asJsonObject
    if (options.keySet().any { it !in setOf("method", "body", "charset", "headers") }
        || options.get("method")?.asString?.uppercase() != "POST"
        || options.get("charset")?.asString?.equals("UTF-8", ignoreCase = true) == false
    ) throw Unsupported("离线请求仅支持静态 UTF-8 POST 选项")
    val requestHeaders = headers + options.getAsJsonObject("headers")?.entrySet()
        .orEmpty().associate { (name, value) -> name.lowercase() to value.asString }
    val body = options.get("body")?.asString.orEmpty()
    if (requestHeaders["content-type"].isNullOrEmpty()) {
        if (body.startsWith("{") || body.startsWith("[") || body.startsWith("<")) throw Unsupported("离线请求仅支持表单 POST")
        return FlowRequest(url, requestHeaders + ("content-type" to "application/x-www-form-urlencoded"), "POST", FlowFormEncoding.encodeForm(body))
    }
    return FlowRequest(url, requestHeaders, "POST", body)
}
