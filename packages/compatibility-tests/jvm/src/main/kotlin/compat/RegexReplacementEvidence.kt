package compat

import com.google.gson.JsonObject
import io.legado.app.model.analyzeRule.AnalyzeByJSoup

/**
 * 固定 AnalyzeRule.kt:544-560 的 replaceRegex 分支。
 * 仅将 SourceRule 结构展开为同一 JSON 输入字段；Regex 替换和 runCatching 回退逻辑照上游执行。
 */
internal fun analyzeRuleRegexReplacement(input: JsonObject): Any {
    val content = input.get("content").asString
    val rule = input.get("rule").asString
    val parts = rule.split("##")
    if (parts.size < 3) throw Unsupported("替换规则必须包含 CSS 选择器、正则和替换串")

    val result = AnalyzeByJSoup(content).getString(parts[0]).orEmpty()
    val replaceRegex = parts[1]
    val replacement = parts[2]
    val replaceFirst = parts.size > 3
    val regex = runCatching { Regex(replaceRegex) }.getOrNull()

    if (replaceFirst) {
        if (regex != null) runCatching {
            val matcher = regex.toPattern().matcher(result)
            return if (matcher.find()) matcher.group(0)!!.replaceFirst(regex, replacement) else ""
        }
        return replacement
    }

    if (regex != null) runCatching { return result.replace(regex, replacement) }
    return result.replace(replaceRegex, replacement)
}
