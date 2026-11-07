package compat

import io.legado.app.model.analyzeRule.AnalyzeByJSoup

/** 离线 CSS 字段片段。解析由固定的上游 AnalyzeByJSoup 执行。 */
internal fun corpusCssString(rule: String, content: Any): String {
    // AnalyzeRule.makeUpRule 先展开子规则，再拆分 ##；每个子规则读取原始输入。
    val interpolated = Regex("\\{\\{([^{}]+)}}").replace(rule) { match ->
        val nested = match.groupValues[1]
        require(nested.startsWith("@@")) { "离线片段仅接受显式 CSS 子规则" }
        corpusCssString(nested, content)
    }
    val parts = interpolated.split("##")
    val selector = parts.first().trim().removePrefix("@@")
    val pattern = parts.getOrElse(1) { "" }
    val replacement = parts.getOrElse(2) { "" }
    val value = when {
        selector.isBlank() && pattern.isNotEmpty() -> content.toString()
        interpolated != rule -> selector
        else -> AnalyzeByJSoup(content).getString(selector) ?: return ""
    }
    if (pattern.isEmpty()) return value

    // AnalyzeRule.replaceRegex 的替换与非法表达式回退由 Kotlin/JDK 执行。
    val regex = runCatching { pattern.toRegex() }.getOrNull()
    if (parts.size > 3) {
        return if (regex == null) replacement else runCatching {
            val first = regex.find(value) ?: return ""
            first.value.replaceFirst(regex, replacement)
        }.getOrDefault(replacement)
    }
    return runCatching { regex?.let { value.replace(it, replacement) } }.getOrNull()
        ?: value.replace(pattern, replacement)
}
