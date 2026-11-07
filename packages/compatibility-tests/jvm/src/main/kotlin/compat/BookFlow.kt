package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.legado.app.constant.AppPattern
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import io.legado.app.utils.FlowHtmlFormatter
import org.jsoup.parser.Parser
import java.net.URL
import java.net.URLEncoder
import java.util.Base64

internal class FlowFixtureError(message: String) : RuntimeException(message)

private fun JsonObject.text(key: String): String = get(key)?.takeUnless { it.isJsonNull }?.asString.orEmpty()
private fun JsonObject.rule(key: String): JsonObject = getAsJsonObject(key) ?: JsonObject()

/** 只覆盖声明式、离线的文本书源分支。应用宿主编排以固定源码为依据。 */
internal fun executeBookFlow(input: JsonObject): Any {
    val source = input.rule("source")
    val sourceUrl = source.text("bookSourceUrl")
    val headers = source.text("header").takeIf(String::isNotEmpty)?.let {
        JsonParser.parseString(it).asJsonObject.entrySet().associate { (name, value) -> name.lowercase() to value.asString }
    }.orEmpty()
    val stages = linkedMapOf<String, Any>()
    val requests = mutableListOf<Map<String, Any?>>()
    val output = mapOf("stages" to stages, "requests" to requests)
    fun resolve(base: String, link: String) = URL(URL(base), link.trim()).toString()
    fun request(stage: String, url: String): Pair<String, String> {
        requests.add(mapOf("stage" to stage, "method" to "GET", "url" to url, "body" to null, "headers" to headers))
        val response = input.rule("responses").entrySet().map { it.value.asJsonObject }.firstOrNull {
            it.text("method") == "GET" && it.text("url") == url && it.get("body").isJsonNull
        }?.rule("response")
        if (response == null || requests.size > input.get("requestLimit").asInt) {
            throw FlowFixtureError("离线请求超限或缺少响应: $stage GET $url")
        }
        if (response.get("status").asInt != 200) throw Unsupported("JVM 流程参考只实现 HTTP 200")
        val bytes = Base64.getDecoder().decode(response.text("base64"))
        return bytes.toString(Charsets.UTF_8) to response.text("url")
    }
    fun result(stage: String, status: String, value: Any?, error: Map<String, String>? = null) {
        stages[stage] = mapOf("status" to status, "value" to value) + (error?.let { mapOf("error" to it) } ?: emptyMap())
    }
    fun field(rule: String, body: Any, unescape: Boolean = true): String {
        if (rule.isEmpty()) return ""
        val value = corpusCssString(rule, body)
        return if (unescape) Parser.unescapeEntities(value, false).trim() else value
    }
    fun fields(rules: JsonObject, body: Any, base: String): Map<String, String> = buildMap {
        for (key in listOf("name", "author", "bookUrl", "coverUrl", "intro", "kind", "updateTime", "lastChapter", "tocUrl")) {
            val raw = field(rules.text(key), body)
            val value = when {
                raw.isEmpty() -> ""
                key in listOf("bookUrl", "coverUrl", "tocUrl") -> resolve(base, raw)
                key == "name" -> raw.replace(AppPattern.nameRegex, "").trim { it <= ' ' }
                key == "author" -> raw.replace(AppPattern.authorRegex, "").trim { it <= ' ' }
                key == "intro" -> FlowHtmlFormatter.formatIntro(raw)
                else -> raw
            }
            if (value.isNotEmpty()) put(key, value)
        }
    }

    val searchRule = source.rule("ruleSearch")
    val detailRule = source.rule("ruleBookInfo")
    val searchUrl = source.text("searchUrl")
    if (searchUrl.contains(",{")) throw Unsupported("JVM 流程参考只实现普通 GET")
    val (searchBody, searchBase) = request("search", resolve(sourceUrl, searchUrl.replace("{{key}}", URLEncoder.encode(input.text("keyword"), Charsets.UTF_8))))
    val rows = AnalyzeByJSoup(searchBody).getElements(searchRule.text("bookList"))
    // BookList 在列表为空且未声明详情 URL 模式时尝试详情规则。
    val fallback = rows.isEmpty() && source.text("bookUrlPattern").isEmpty()
    val candidates = if (fallback) {
        listOf(fields(detailRule, searchBody, searchBase) + ("bookUrl" to searchBase))
    } else {
        rows.map { (fields(searchRule, it, searchBase) - "updateTime").let { book -> book + ("bookUrl" to (book["bookUrl"] ?: searchBase)) } }
    }.filter { it.containsKey("name") }.distinctBy { it["bookUrl"] }
    result("search", if (candidates.isEmpty()) "empty" else "success", candidates)
    val candidate = candidates.firstOrNull() ?: return output

    val bookUrl = candidate.getValue("bookUrl")
    val (detailBody, detailBase) = if (fallback || bookUrl == searchBase) searchBody to bookUrl else request("detail", bookUrl)
    // BookInfo 需要显式配置 canReName，才能覆盖已有书名和作者。
    val detailFields = fields(detailRule, detailBody, detailBase)
    val preserved = if (detailRule.text("canReName").isBlank()) candidate.filterKeys { it == "name" || it == "author" } else emptyMap()
    val detail = candidate + detailFields + preserved
    val tocUrl = detail["tocUrl"] ?: bookUrl
    result("detail", "success", detail + ("tocUrl" to tocUrl))

    // WebBook 仅在目录 URL 与详情 URL 相同时复用详情响应。
    val (tocBody, tocBase) = if (tocUrl == bookUrl) detailBody to bookUrl else request("toc", tocUrl)
    val tocRule = source.rule("ruleToc")
    val chapters = AnalyzeByJSoup(tocBody).getElements(tocRule.text("chapterList")).mapNotNull { node ->
        val title = field(tocRule.text("chapterName"), node)
        val url = field(tocRule.text("chapterUrl"), node)
        if (title.isEmpty() || url.isEmpty()) null else mapOf("title" to title, "chapterUrl" to resolve(tocBase, url), "isVip" to false)
    }.distinctBy { it["chapterUrl"] }
    if (chapters.isEmpty()) {
        result("toc", "failed", null, mapOf("category" to "toc-empty", "class" to "TocEmptyException", "message" to "目录为空"))
        return output
    }
    result("toc", "success", chapters)

    val chapter = chapters.first()
    val (contentBody, _) = request("content", chapter.getValue("chapterUrl").toString())
    val contentRule = source.rule("ruleContent")
    val raw = field(contentRule.text("content"), contentBody, unescape = false)
    if (raw.contains("<img", ignoreCase = true) || raw.contains("<usehtml>")) throw Unsupported("JVM 流程参考只实现普通文本格式化")
    var cleaned = Parser.unescapeEntities(FlowHtmlFormatter.format(raw), false)
    val replaceRule = contentRule.text("replaceRegex")
    if (replaceRule.isNotEmpty()) {
        // BookContent 在逐页格式化与拼接之后执行正文替换，再恢复在线文本缩进。
        cleaned = corpusCssString(replaceRule, cleaned.split(AppPattern.LFRegex).joinToString("\n") { it.trim() })
            .split(AppPattern.LFRegex).joinToString("\n") { "　　$it" }
    }
    if (cleaned.isBlank()) {
        result("content", "failed", null, mapOf("category" to "content-empty", "class" to "ContentEmptyException", "message" to "内容为空"))
        return output
    }
    val title = field(contentRule.text("title"), contentBody).ifEmpty { chapter.getValue("title").toString() }
    result("content", "success", mapOf("title" to title, "pageCount" to 1, "cleaned" to cleaned))
    return output
}
