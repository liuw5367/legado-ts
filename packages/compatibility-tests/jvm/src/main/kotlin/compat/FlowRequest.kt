package compat

import com.google.gson.JsonParser
import io.legado.app.utils.FlowFormEncoding
import java.net.URLEncoder
import java.util.IdentityHashMap
import java.nio.charset.Charset
import org.htmlunit.corejs.javascript.BaseFunction
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.Scriptable
import org.htmlunit.corejs.javascript.VarScope
import org.htmlunit.corejs.javascript.JavaScriptException

internal data class FlowRequest(
    val url: String,
    val headers: Map<String, String>,
    val method: String = "GET",
    val body: String? = null,
    val bodyScript: String? = null,
)

internal fun flowSearchRequest(
    rule: String,
    keyword: String,
    headers: Map<String, String>,
    exactHeaders: Boolean = false,
    resolve: (String) -> String,
): FlowRequest {
    // AnalyzeUrl.paramPattern 分隔 URL 和选项，静态关键字在解析选项前展开。
    val separator = Regex("\\s*,\\s*(?=\\{)").find(rule)
        ?: return FlowRequest(resolve(rule.replace("{{key}}", URLEncoder.encode(keyword, Charsets.UTF_8))), headers)
    val address = rule.substring(0, separator.range.first).replace("{{key}}", keyword)
    val options = JsonParser.parseString(rule.substring(separator.range.last + 1).replace("{{key}}", keyword)).asJsonObject
    val method = options.get("method")?.asString?.uppercase() ?: "GET"
    if (options.keySet().any { it !in setOf("method", "body", "charset", "headers", "bodyJs") } || method !in setOf("GET", "POST")) {
        throw Unsupported("离线请求仅支持静态 GET 或表单 POST 选项")
    }
    val charsetName = options.get("charset")?.asString?.takeIf(String::isNotEmpty)
    val charset = try {
        charsetName?.let(Charset::forName) ?: Charsets.UTF_8
    } catch (_: IllegalArgumentException) {
        throw Unsupported("JDK 缺少请求字符集: $charsetName")
    }
    val requestHeaders = headers + options.getAsJsonObject("headers")?.entrySet()
        .orEmpty().associate { (name, value) -> (if (exactHeaders) name else name.lowercase()) to value.asString }
    val bodyScript = options.get("bodyJs")?.asString?.takeIf(String::isNotBlank)
    if (method == "GET") {
        // AnalyzeUrl 的查询编码保留 RFC3986 UNRESERVED 和固定的查询分隔字符。
        val querySafe = "-._~!$%&()*+,/:;=?@[\\]^`{|}"
        val url = if ('?' !in address) resolve(address) else {
            val query = address.substringAfter('?').toByteArray(charset).joinToString("") { byte ->
                val unsigned = byte.toInt() and 255
                val char = unsigned.toChar()
                if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char in querySafe) char.toString()
                else "%%%02X".format(unsigned)
            }
            resolve(address.substringBefore('?') + "?" + query)
        }
        return FlowRequest(url, requestHeaders, bodyScript = bodyScript)
    }
    val url = resolve(address)
    val body = options.get("body")?.asString.orEmpty()
    if (requestHeaders["content-type"].isNullOrEmpty()) {
        if (body.startsWith("{") || body.startsWith("[") || body.startsWith("<")) throw Unsupported("离线请求仅支持表单 POST")
        return FlowRequest(url, requestHeaders + ("content-type" to "application/x-www-form-urlencoded"), "POST", FlowFormEncoding.encodeForm(body, charset, checkEncoded = charsetName == null), bodyScript)
    }
    return FlowRequest(url, requestHeaders, "POST", body, bodyScript)
}

/** AnalyzeUrl 的 URL 脚本片段，仅提供当前离线案例所需的 GET 与表单关键字编码。 */
internal fun evaluateFlowSearchUrl(rule: String, keyword: String, ajax: (String) -> String): String {
    if (!rule.startsWith("@js:", ignoreCase = true)) return rule
    return evaluateFlowRequestScript(rule.substring(4), keyword, "", ajax)
}

internal fun evaluateFlowRequestScript(code: String, keyword: String, content: String, ajax: (String) -> String): String {
    val newContext = Context.getCurrentContext() == null
    return Context.enter().use { engine ->
        if (newContext) engine.setClassShutter { false }
        val scope = engine.initSafeStandardObjects()
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
        scope.put("result", scope, content)
        Context.toString(engine.evaluateString(scope, code, "offline-request-script", 1, null))
    }
}

internal data class FlowHttpResponse(val body: String, val url: String, val status: Int)

/** WebBook 的登录检查片段。仅暴露本案例读取的响应成员及同一请求的重取。 */
internal fun evaluateFlowLoginCheck(
    code: String,
    initial: FlowHttpResponse,
    headers: Map<String, String>,
    exactHeaders: Boolean,
    refetch: (Map<String, String>) -> FlowHttpResponse,
): FlowHttpResponse? {
    val mutableHeaders = headers.toMutableMap()
    return Context.enter().use { engine ->
        engine.setClassShutter { false }
        val scope = engine.initSafeStandardObjects()
        val java = engine.newObject(scope)
        val headerMap = engine.newObject(scope)
        val responses = IdentityHashMap<Scriptable, FlowHttpResponse>()
        fun bind(target: Scriptable, name: String, callback: (Array<Any>) -> Any?) {
            target.put(name, target, object : BaseFunction() {
                override fun call(cx: Context, scope: VarScope, thisObj: Scriptable, args: Array<Any>): Any? = callback(args)
            })
        }
        fun wrap(response: FlowHttpResponse): Scriptable {
            val objectValue = engine.newObject(scope)
            responses[objectValue] = response
            bind(objectValue, "code") { response.status }
            bind(objectValue, "body") { response.body }
            bind(objectValue, "url") { response.url }
            return objectValue
        }
        fun headerName(value: Any): String = Context.toString(value).let { if (exactHeaders) it else it.lowercase() }
        bind(headerMap, "get") { args -> mutableHeaders[headerName(args[0])] }
        bind(headerMap, "put") { args -> mutableHeaders.put(headerName(args[0]), Context.toString(args[1])) }
        bind(java, "getHeaderMap") { headerMap }
        bind(java, "getStrResponse") { args ->
            require(args.size == 3 && args[0] == null && args[1] == null && args[2] == false) {
                "离线参考仅支持 getStrResponse(null, null, false)"
            }
            wrap(refetch(mutableHeaders.toMap()))
        }
        scope.put("java", scope, java)
        scope.put("result", scope, wrap(initial))
        try {
            val returned = engine.evaluateString(scope, code, "offline-login-check", 1, null)
            responses[returned]
        } catch (_: JavaScriptException) {
            // WebBook 在脚本抛错后用错误响应再调用；本案例的 500 分支不发请求。
            scope.put("result", scope, wrap(FlowHttpResponse("", initial.url, 500)))
            try {
                responses[engine.evaluateString(scope, code, "offline-login-error", 1, null)]?.takeUnless { it.status == 500 }
            } catch (_: JavaScriptException) {
                null
            }
        }
    }
}
