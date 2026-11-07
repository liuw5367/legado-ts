package compat

import com.google.gson.JsonObject
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
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
