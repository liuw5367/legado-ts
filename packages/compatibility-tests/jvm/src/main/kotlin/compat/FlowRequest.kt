package compat

import com.google.gson.JsonParser
import io.legado.app.utils.FlowFormEncoding
import java.net.URLEncoder
import org.htmlunit.corejs.javascript.BaseFunction
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.Scriptable
import org.htmlunit.corejs.javascript.VarScope

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

/** AnalyzeUrl 的 URL 脚本片段，仅提供当前离线案例所需的 GET 与表单关键字编码。 */
internal fun evaluateFlowSearchUrl(rule: String, keyword: String, ajax: (String) -> String): String {
    if (!rule.startsWith("@js:", ignoreCase = true)) return rule
    return Context.enter().use { engine ->
        val scope = engine.initSafeStandardObjects()
        engine.setClassShutter { false }
        val java = engine.newObject(scope)
        fun bind(name: String, callback: (String) -> String) {
            java.put(name, java, object : BaseFunction() {
                override fun call(cx: Context, scope: VarScope, thisObj: Scriptable, args: Array<Any>): Any =
                    callback(Context.toString(args.single()))
            })
        }
        bind("ajax", ajax)
        // 固定上游 JsExtensions.encodeURI(String) 使用 UTF-8 URLEncoder。
        bind("encodeURI") { URLEncoder.encode(it, Charsets.UTF_8) }
        scope.put("java", scope, java)
        scope.put("key", scope, keyword)
        Context.toString(engine.evaluateString(scope, rule.substring(4), "offline-search-url", 1, null))
    }
}
