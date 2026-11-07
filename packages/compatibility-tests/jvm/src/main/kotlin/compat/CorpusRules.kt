package compat

import io.legado.app.constant.AppPattern
import io.legado.app.help.CorpusJsExtensions
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import org.htmlunit.corejs.javascript.BaseFunction
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.NativeArray
import org.htmlunit.corejs.javascript.Scriptable
import org.htmlunit.corejs.javascript.ScriptableObject
import java.util.IdentityHashMap
import org.htmlunit.corejs.javascript.VarScope
import org.jsoup.nodes.Element

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
    val value = when {
        selector.isBlank() && pattern.isNotEmpty() -> content.toString()
        interpolated != rule -> selector
        else -> AnalyzeByJSoup(content).getString(selector) ?: return ""
    }
    return replaceCorpusValue(value, parts)
}

private fun replaceCorpusValue(value: String, parts: List<String>): String {
    val pattern = parts.getOrElse(1) { "" }
    if (pattern.isEmpty()) return value
    val replacement = parts.getOrElse(2) { "" }
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

internal fun corpusScriptRule(rule: String, content: String, nodes: Boolean, custom: String): Any? =
    if (nodes) corpusScriptNodes(rule, content, custom).map { node ->
        mapOf("tag" to node.tagName(), "text" to node.text(), "id" to node.id())
    } else runCorpusScript(rule, content, false, custom)

internal fun corpusScriptNodes(rule: String, content: String, custom: String = ""): List<Element> =
    (runCorpusScript(rule, content, true, custom) as List<*>).map { it as Element }

private fun runCorpusScript(rule: String, content: String, nodes: Boolean, custom: String): Any? {
    val script = AppPattern.JS_PATTERN.matcher(rule)
    require(script.find()) { "缺少离线 JS 规则" }
    val prefix = rule.substring(0, script.start()).trim()
    val parts = (script.group(2) ?: script.group(1)).split("##")
    val parser = AnalyzeByJSoup(content)
    val selected = IdentityHashMap<Scriptable, Element>()

    return Context.enter().use { engine ->
        val scope = engine.initSafeStandardObjects()
        engine.setClassShutter { false }
        val java = engine.newObject(scope)
        val book = engine.newObject(scope)
        fun bind(target: Scriptable, name: String, callback: (String) -> Any?) {
            target.put(name, target, object : BaseFunction() {
                override fun call(cx: Context, scope: VarScope, thisObj: Scriptable, args: Array<Any>): Any? =
                    callback(Context.toString(args.firstOrNull() ?: ""))
            })
        }
        fun select(selector: String): Scriptable {
            // 保留节点引用，避免序列化相同的元素被脚本结果合并。
            val values = parser.getElements(selector).map { element ->
                val node = object : ScriptableObject() {
                    override fun getClassName() = "Element"
                    override fun getDefaultValue(hint: Class<*>?): Any = element.outerHtml()
                }
                node.parentScope = scope
                selected[node] = element
                node
            }
            return engine.newArray(scope, values.toTypedArray<Any>())
        }
        bind(java, "getElements", ::select)
        bind(java, "toNumChapter", CorpusJsExtensions::toNumChapter)
        bind(book, "getVariable") { if (it == "custom") custom else "" }
        scope.put("java", scope, java)
        scope.put("book", scope, book)
        val initial = when {
            prefix.isEmpty() -> content
            nodes -> select(prefix)
            else -> corpusCssString(prefix, content)
        }
        scope.put("result", scope, initial)
        val result = engine.evaluateString(scope, parts.first(), "offline-corpus", 1, null)
        if (nodes) {
            require(result is NativeArray) { "目录脚本必须返回节点列表" }
            result.map { value -> selected.getValue(value as Scriptable) }
        } else replaceCorpusValue(Context.toString(result), parts)
    }
}
