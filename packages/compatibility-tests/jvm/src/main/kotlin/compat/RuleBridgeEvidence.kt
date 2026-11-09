package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.legado.app.help.http.StrResponse
import okhttp3.Headers
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import org.htmlunit.corejs.javascript.Context
import org.jsoup.parser.Parser
import java.net.URL

/** 固定 AnalyzeRule 的 HTML 分支：布尔重载控制解实体，URL 模式选首项，null 内容回退当前文档。 */
internal fun analyzeRuleStringOverloads(input: JsonObject): Any {
    fun text(key: String) = input.get(key).asString
    val parser = AnalyzeByJSoup(text("content"))
    val textRule = text("textRule")
    val urlRule = text("urlRule")
    val redirect = URL(text("redirectUrl"))
    val raw = parser.getString(textRule).orEmpty()
    val urls = parser.getStringList(urlRule)
    val decoded = Parser.unescapeEntities(raw, false)
    val firstUrl = Parser.unescapeEntities(parser.getString0(urlRule), false)
    return mapOf(
        "literal" to raw,
        "unescaped" to decoded,
        "fallback" to decoded,
        "url" to if (firstUrl.isBlank()) text("baseUrl") else URL(redirect, firstUrl).toString(),
        "list" to urls,
        "urlList" to urls.map { URL(redirect, it).toString() }.distinct(),
    )
}

internal fun bridgeReturnedObjects(input: JsonObject): Any {
    fun text(key: String) = input.get(key).asString
    return when (text("kind")) {
        "map" -> {
            val map = HashMap<String, String>()
            val missing = map["item"]
            val first = map.put("item", "甲")
            val second = map.put("item", "乙")
            mapOf("missing" to missing, "first" to first, "second" to second, "current" to map["item"], "size" to map.size)
        }
        "map-putall" -> runMapPutAllScript("""
            var source = new Packages.java.util.HashMap();
            source.put("shared", "new"); source.put("copied", "value");
            source.put("nullValue", null); source.put(null, "null-key");
            var target = new Packages.java.util.HashMap();
            target.put("shared", "old"); target.put("retained", "keep");
            var result = target.putAll(source);
            JSON.stringify({voidReturn: result === undefined, overwritten: target.get("shared"),
                copied: target.get("copied"), nullValuePresent: target.containsKey("nullValue"),
                nullValue: target.get("nullValue"), nullKeyValue: target.get(null),
                retained: target.get("retained"), size: target.size()})
        """.trimIndent())
        "map-putall-null" -> runMapPutAllScript("""
            var target = new Packages.java.util.HashMap();
            var threw = false;
            try { target.putAll(null); } catch (error) { threw = true; }
            JSON.stringify({threw: threw, size: target.size()})
        """.trimIndent())
        "list" -> {
            val list = arrayListOf("甲", null, "乙")
            mapOf("index" to list[1], "last" to list[2], "items" to list.toArray())
        }
        "node" -> {
            val node = AnalyzeByJSoup(text("content")).getElements(".item")[0]
            mapOf("text" to node.text(), "selected" to node.select("a").attr("href"))
        }
        "response" -> {
            val headers = Headers.Builder()
            for ((name, values) in input.getAsJsonObject("headers").entrySet()) {
                for (value in values.asJsonArray) headers.add(name, value.asString)
            }
            val raw = Response.Builder().request(Request.Builder().url(text("url")).build())
                .protocol(Protocol.HTTP_1_1).code(206).message("Partial Content").headers(headers.build()).build()
            val response = StrResponse(raw, text("content"))
            val observed = response.headers()
            mapOf("body" to response.body(), "status" to response.code(), "missing" to observed["missing"],
                "last" to observed["x-test"], "all" to observed.values("X-Test"))
        }
        else -> throw Unsupported("未知返回对象案例")
    }
}

private fun runMapPutAllScript(script: String): JsonObject = Context.enter().use { context ->
    val scope = context.initStandardObjects()
    val result = context.evaluateString(scope, script, "HashMap.putAll", 1, null)
    JsonParser.parseString(Context.toString(result)).asJsonObject
}
