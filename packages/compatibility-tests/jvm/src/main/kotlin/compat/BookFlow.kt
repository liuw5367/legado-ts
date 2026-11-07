package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.legado.app.constant.AppPattern
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import io.legado.app.model.analyzeRule.AnalyzeByJSonPath
import io.legado.app.utils.FlowHtmlFormatter
import io.legado.app.utils.StringUtils.wordCountFormat
import io.legado.app.utils.isTrue
import org.jsoup.parser.Parser
import java.net.URL
import java.util.Base64

internal class FlowFixtureError(message: String) : RuntimeException(message)

private fun JsonObject.text(key: String): String = get(key)?.takeUnless { it.isJsonNull }?.asString.orEmpty()
private fun JsonObject.rule(key: String): JsonObject = getAsJsonObject(key) ?: JsonObject()

/** 只覆盖声明式、离线的文本书源分支。应用宿主编排以固定源码为依据。 */
internal fun executeBookFlow(input: JsonObject, tocOnly: Boolean = false): Any {
    val source = input.rule("source")
    val sourceUrl = source.text("bookSourceUrl")
    val unsupported = listOf(
        source.text("mainJs"), source.text("loginUrl"), source.text("loginCheckJs"),
        source.rule("ruleBookInfo").text("init"),
        source.rule("ruleToc").text("formatJs"),
        source.rule("ruleContent").text("webJs"),
    )
    if (unsupported.any(String::isNotBlank) || source.text("bookSourceType") !in setOf("", "0")) {
        throw Unsupported("JVM 流程参考只实现无需登录的声明式文本书源")
    }
    val headers = source.text("header").takeIf(String::isNotEmpty)?.let {
        JsonParser.parseString(it).asJsonObject.entrySet().associate { (name, value) -> name.lowercase() to value.asString }
    }.orEmpty()
    val variables = input.rule("bookVariables").entrySet().associate { (key, value) -> key to value.asString }.toMutableMap()
    val variableKeys = input.getAsJsonArray("variableKeys")?.map { it.asString }
    val stages = linkedMapOf<String, Any>()
    val requests = mutableListOf<Map<String, Any?>>()
    val output = mapOf("stages" to stages, "requests" to requests)
    fun resolve(base: String, link: String): String {
        val relative = link.trim()
        // Android 15 libcore URLStreamHandler.parseURL 移除了 query-only 分支的路径截断。
        if (relative.startsWith("?")) return base.substringBefore('#').substringBefore('?') + relative
        return URL(URL(base), relative).toString()
    }
    val requestEvidence = input.get("requestEvidence")?.asBoolean == true
    fun request(stage: String, plan: FlowRequest): Pair<String, String> {
        val response = input.rule("responses").entrySet().map { it.value.asJsonObject }.firstOrNull {
            it.text("method") == plan.method && it.text("url") == plan.url && it.get("body").let { body ->
                (if (body.isJsonNull) null else body.asString) == plan.body
            }
        }?.rule("response")
        if (response == null || requests.size >= input.get("requestLimit").asInt) {
            throw FlowFixtureError("离线请求超限或缺少响应: $stage ${plan.method} ${plan.url}")
        }
        val trace = mapOf("stage" to stage, "method" to plan.method, "url" to plan.url, "body" to plan.body, "headers" to plan.headers)
        requests.add(if (requestEvidence) trace + mapOf(
            "bodyBase64" to plan.body?.let { Base64.getEncoder().encodeToString(it.toByteArray(Charsets.UTF_8)) },
            "responseUrl" to response.text("url"),
        ) else trace)
        if (response.get("status").asInt != 200) throw Unsupported("JVM 流程参考只实现 HTTP 200")
        val bytes = Base64.getDecoder().decode(response.text("base64"))
        return bytes.toString(Charsets.UTF_8) to response.text("url")
    }
    fun request(stage: String, url: String) = request(stage, FlowRequest(url, headers))
    fun result(stage: String, status: String, value: Any?, error: Map<String, String>? = null) {
        stages[stage] = buildMap {
            put("status", status)
            put("value", value)
            if (error != null) put("error", error)
            if (variableKeys != null && (stage == "detail" || stage == "toc")) {
                put("variables", variables.filterKeys { it in variableKeys })
            }
        }
    }
    fun field(rule: String, body: Any, unescape: Boolean = true): String {
        if (rule.isEmpty()) return ""
        val value = when {
            AppPattern.JS_PATTERN.matcher(rule).find() -> corpusScriptString(rule, body, variables)
            rule.startsWith("$.") || rule.startsWith("$[") -> AnalyzeByJSonPath(body).getString(rule).orEmpty()
            else -> corpusCssString(rule, body)
        }
        return if (unescape) Parser.unescapeEntities(value, false).trim() else value
    }
    fun nodes(rule: String, body: String): List<Any> = when {
        AppPattern.JS_PATTERN.matcher(rule).find() -> corpusScriptNodes(rule, body, variables)
        rule.startsWith("$.") || rule.startsWith("$[") -> AnalyzeByJSonPath(body).getList(rule).orEmpty()
        else -> AnalyzeByJSoup(body).getElements(rule)
    }

    fun fields(rules: JsonObject, body: Any, base: String): Map<String, String> = buildMap {
        for (key in listOf("name", "author", "bookUrl", "coverUrl", "intro", "kind", "wordCount", "lastChapter", "tocUrl")) {
            val raw = field(rules.text(key), body)
            val value = when {
                raw.isEmpty() -> ""
                key in listOf("bookUrl", "coverUrl", "tocUrl") -> resolve(base, raw)
                key == "name" -> raw.replace(AppPattern.nameRegex, "").trim { it <= ' ' }
                key == "author" -> raw.replace(AppPattern.authorRegex, "").trim { it <= ' ' }
                key == "wordCount" -> wordCountFormat(raw)
                key == "intro" -> FlowHtmlFormatter.formatIntro(raw)
                else -> raw
            }
            if (value.isNotEmpty()) put(key, value)
        }
    }

    val tocUrl: String
    val cachedToc: Pair<String, String>?
    if (tocOnly) {
        tocUrl = input.rule("book").text("tocUrl")
        cachedToc = null
    } else {
        val searchRule = source.rule("ruleSearch")
        val detailRule = source.rule("ruleBookInfo")
        val keyword = input.text("keyword")
        val searchRuleUrl = evaluateFlowSearchUrl(source.text("searchUrl"), keyword) { url ->
            request("search", resolve(sourceUrl, url)).first
        }
        val searchPlan = flowSearchRequest(searchRuleUrl, keyword, headers) { resolve(sourceUrl, it) }
        val (searchBody, searchBase) = request("search", searchPlan)
        val bookUrlPattern = source.text("bookUrlPattern")
        val directDetail = bookUrlPattern.isNotEmpty() && Regex(bookUrlPattern).matches(searchBase)
        val rows = if (directDetail) emptyList() else nodes(searchRule.text("bookList"), searchBody)
        // BookList 在列表为空且未声明详情 URL 模式时尝试详情规则。
        val fallback = directDetail || (rows.isEmpty() && bookUrlPattern.isEmpty())
        val candidates = if (fallback) {
            listOf(fields(detailRule, searchBody, searchBase) + ("bookUrl" to searchBase))
        } else {
            rows.map { fields(searchRule, it, searchBase).let { book -> book + ("bookUrl" to (book["bookUrl"] ?: searchBase)) } }
        }.filter { it.containsKey("name") }.distinctBy { it["bookUrl"] }
        result("search", if (candidates.isEmpty()) "empty" else "success", candidates)
        val candidate = candidates.firstOrNull() ?: return output

        val bookUrl = candidate.getValue("bookUrl")
        val (detailBody, detailBase) = if (fallback || bookUrl == searchBase) searchBody to bookUrl else request("detail", bookUrl)
        // BookInfo 需要显式配置 canReName，才能覆盖已有书名和作者。
        val detailFields = fields(detailRule, detailBody, detailBase)
        val preserved = if (detailRule.text("canReName").isBlank()) candidate.filterKeys { it == "name" || it == "author" } else emptyMap()
        val detail = candidate + detailFields + preserved
        tocUrl = detail["tocUrl"] ?: bookUrl
        result("detail", "success", detail + ("tocUrl" to tocUrl))
        if (input.text("stopAfter") == "detail") return output

        // WebBook 在目录 URL 与详情 URL 相同时复用详情响应。
        cachedToc = if (tocUrl == bookUrl) detailBody to bookUrl else null
    }
    val (tocBody, tocBase) = cachedToc ?: request("toc", tocUrl)
    val tocRule = source.rule("ruleToc")
    val listRule = tocRule.text("chapterList")
    val chapterRule = listRule.removePrefix("-").removePrefix("+")
    val nextToc = tocRule.text("nextTocUrl")
    val candidatesByPage = mutableListOf<Map<String, Any>>()
    var tocPage = tocBody
    var pageBase = tocBase
    var tocRequestUrl = tocUrl
    val visitedToc = mutableSetOf(tocBase)
    while (true) {
        nodes(chapterRule, tocPage).forEachIndexed { index, node ->
            val title = field(tocRule.text("chapterName"), node)
            val url = field(tocRule.text("chapterUrl"), node)
            val isVolume = field(tocRule.text("isVolume"), node).isTrue()
            val rawUrl = url.ifEmpty { if (isVolume) title + index else tocRequestUrl }
            if (title.isNotEmpty()) candidatesByPage.add(mapOf(
                "title" to title, "url" to rawUrl,
                "chapterUrl" to if (isVolume && rawUrl.startsWith(title)) rawUrl else resolve(pageBase, rawUrl),
                "isVip" to field(tocRule.text("isVip"), node).isTrue(),
                "isPay" to field(tocRule.text("isPay"), node).isTrue(),
                "isVolume" to isVolume,
            ))
        }
        if (nextToc.isEmpty()) break
        val nextLinks = AnalyzeByJSoup(tocPage).getStringList(nextToc).filter { it.isNotBlank() }
            .map { resolve(pageBase, it) }.filter { it != pageBase }.distinct()
        if (nextLinks.size > 1) throw Unsupported("JVM 流程参考只实现单链接目录分页")
        val target = nextLinks.firstOrNull() ?: break
        if (!visitedToc.add(target)) break
        tocPage = request("toc", target).first
        // Android 串行目录下一页用请求地址作为解析基准，首轮则使用响应最终地址。
        pageBase = target
        tocRequestUrl = target
    }
    // BookChapter.equals 按原始 url 判等。BookChapterList 先反序、去重，再应用显示顺序。
    val ordered = if (listRule.startsWith("-")) candidatesByPage else candidatesByPage.asReversed()
    val chapters = ordered.distinctBy { it["url"] }.asReversed().mapIndexed { index, chapter ->
        chapter + ("index" to index)
    }
    if (chapters.isEmpty()) {
        result("toc", "failed", null, mapOf("category" to "toc-empty", "class" to "TocEmptyException", "message" to "Chapters is empty"))
        return output
    }
    result("toc", "success", chapters.map { it - "url" })
    if (tocOnly) return output

    val chapterIndex = input.get("chapterIndex")?.asInt ?: 0
    val chapter = chapters.getOrNull(chapterIndex) ?: throw FlowFixtureError("目录没有指定章节: $chapterIndex")
    val contentRule = source.rule("ruleContent")
    val nextRule = contentRule.text("nextContentUrl")
    val nextChapter = chapters[(chapterIndex + 1) % chapters.size]["chapterUrl"]
    val visited = mutableSetOf<String>()
    val pages = mutableListOf<String>()
    var url = chapter.getValue("chapterUrl").toString()
    var contentBody = ""
    // BookContent 的单地址分支顺序追加正文，并在遇到下一章或已访问地址时停止。
    while (visited.add(url)) {
        val (body, responseUrl) = request("content", url)
        if (pages.isEmpty()) contentBody = body
        val raw = field(contentRule.text("content"), body, unescape = false)
        if (raw.contains("<img", ignoreCase = true) || raw.contains("<usehtml>")) throw Unsupported("JVM 流程参考只实现普通文本格式化")
        pages.add(Parser.unescapeEntities(FlowHtmlFormatter.format(raw), false))
        val next = when {
            nextRule.isEmpty() -> emptyList()
            nextRule.startsWith("$.") || nextRule.startsWith("$[") -> AnalyzeByJSonPath(body).getStringList(nextRule)
            else -> AnalyzeByJSoup(body).getStringList(nextRule)
        }.filter { it.isNotBlank() }.map { resolve(responseUrl, it) }
        if (next.size > 1) throw Unsupported("JVM 流程参考只实现单链接正文分页")
        val target = next.firstOrNull()
        if (target == null || target == nextChapter) break
        url = target
    }
    var cleaned = pages.joinToString("\n")
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
    result("content", "success", mapOf("title" to title, "pageCount" to pages.size, "cleaned" to cleaned))
    return output
}
