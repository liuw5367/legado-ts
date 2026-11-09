package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.Gson
import io.legado.app.help.http.StrResponse
import okhttp3.Headers
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.ScriptableObject
import org.jsoup.parser.Parser
import org.jsoup.select.Elements
import java.net.URL

/** Mirrors the non-null Kotlin method entry declared by Android AnalyzeRule.getElements(String). */
internal class AnalyzeRuleGetElementsProbe(private val parser: AnalyzeByJSoup) {
    fun getElements(rule: String): Elements =
        if (rule.trim { it <= ' ' }.isEmpty()) Elements() else parser.getElements(rule)
}

internal fun analyzeRuleGetElementsNullability(input: JsonObject): Any {
    val content = input.get("content").asString
    val rule = input.get("rule").asString
    val parser = AnalyzeByJSoup(content)
    val probe = AnalyzeRuleGetElementsProbe(parser)
    val elements = probe.getElements(rule)
    val scope = Context.enter().use { context ->
        val currentScope = context.initStandardObjects()
        ScriptableObject.putProperty(currentScope, "java", Context.javaToJS(probe, currentScope))
        val output = context.evaluateString(
            currentScope,
            "var nullCaught=false; try { java.getElements(null); } catch (error) { nullCaught=true; } JSON.stringify({nullCaught:nullCaught,nextCount:java.getElements('p').size()});",
            "AnalyzeRule.getElements(String)", 1, null,
        )
        JsonParser.parseString(Context.toString(output)).asJsonObject
    }
    return mapOf(
        "count" to elements.size,
        "firstText" to elements.firstOrNull()?.text().orEmpty(),
        "emptyCount" to probe.getElements(" ").size,
        "nullCaught" to scope.get("nullCaught").asBoolean,
        "nextCount" to scope.get("nextCount").asInt,
    )
}

/** Mirrors the HTML overload behavior exercised from book-source JavaScript. */
internal class AnalyzeRuleStringProbe(private val content: String) {
    @JvmOverloads
    fun getString(rule: String?, mContent: Any? = null, isUrl: Boolean = false): String =
        getStringValue(rule, mContent, unescape = true, isUrl = isUrl)

    fun getString(rule: String?, unescape: Boolean): String =
        getStringValue(rule, null, unescape = unescape, isUrl = false)

    @JvmOverloads
    fun getStringList(rule: String?, mContent: Any? = null, isUrl: Boolean = false): List<String>? {
        if (rule.isNullOrEmpty()) return null
        val normalized = rule.trim { it <= ' ' }
        if (normalized.isEmpty()) return null
        val values = AnalyzeByJSoup((mContent ?: content).toString()).getStringList(normalized)
        if (!isUrl) return values
        val redirectBase = URL("https://redirect.fixture.test/chapters/")
        return values.map { URL(redirectBase, it).toString() }.distinct()
    }

    private fun getStringValue(rule: String?, mContent: Any?, unescape: Boolean, isUrl: Boolean): String {
        if (rule.isNullOrEmpty()) return ""
        val normalized = rule.trim { it <= ' ' }
        if (normalized.isEmpty()) return ""
        val parser = AnalyzeByJSoup((mContent ?: content).toString())
        val value = (if (isUrl) parser.getString0(normalized) else parser.getString(normalized)).orEmpty()
        return if (unescape && value.contains('&')) Parser.unescapeEntities(value, false) else value
    }
}

internal fun analyzeRuleStringBoundary(input: JsonObject): Any {
    val probe = AnalyzeRuleStringProbe(input.get("content").asString)
    val invalidRule = Gson().toJson(input.get("invalidRule").asString)
    val textRule = Gson().toJson(input.get("textRule").asString)
    val scope = Context.enter().use { context ->
        val currentScope = context.initStandardObjects()
        ScriptableObject.putProperty(currentScope, "java", Context.javaToJS(probe, currentScope))
        val script = """
            var stringErrorCaught=false;
            try { java.getString($invalidRule, false); } catch (error) { stringErrorCaught=true; }
            var listErrorCaught=false;
            try { java.getStringList($invalidRule); } catch (error) { listErrorCaught=true; }
            JSON.stringify({
              nullStringEmpty:String(java.getString(null))==='',
              blankStringEmpty:String(java.getString(' ',false))==='',
              nullListNull:java.getStringList(null)===null,
              blankListNull:java.getStringList(' ')===null,
              literal:java.getString($textRule,false),
              unescaped:java.getString($textRule,true),
              missingStringEmpty:String(java.getString('h2@text'))==='',
              missingListEmpty:java.getStringList('h2@href').size()===0,
              stringErrorCaught:stringErrorCaught,
              listErrorCaught:listErrorCaught,
              continued:java.getString($textRule,true)
            });
        """.trimIndent()
        val output = context.evaluateString(
            currentScope,
            script,
            "AnalyzeRule.getString/getStringList(String, ...)", 1, null,
        )
        JsonParser.parseString(Context.toString(output)).asJsonObject
    }
    return mapOf(
        "nullStringEmpty" to scope.get("nullStringEmpty").asBoolean,
        "blankStringEmpty" to scope.get("blankStringEmpty").asBoolean,
        "nullListNull" to scope.get("nullListNull").asBoolean,
        "blankListNull" to scope.get("blankListNull").asBoolean,
        "literal" to scope.get("literal").asString,
        "unescaped" to scope.get("unescaped").asString,
        "missingStringEmpty" to scope.get("missingStringEmpty").asBoolean,
        "missingListEmpty" to scope.get("missingListEmpty").asBoolean,
        "stringErrorCaught" to scope.get("stringErrorCaught").asBoolean,
        "listErrorCaught" to scope.get("listErrorCaught").asBoolean,
        "continued" to scope.get("continued").asString,
    )
}

/** 固定 AnalyzeRule 的 HTML 分支：布尔重载控制解实体，URL 模式选首项，null 内容回退当前文档。 */
internal fun analyzeRuleStringOverloads(input: JsonObject): Any {
    if (input.get("mode")?.asString == "boundaries") return analyzeRuleStringBoundary(input)
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
