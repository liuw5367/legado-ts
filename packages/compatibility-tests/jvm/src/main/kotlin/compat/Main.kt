package compat

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.jayway.jsonpath.Configuration
import com.jayway.jsonpath.JsonPath
import com.jayway.jsonpath.Option
import io.legado.app.model.analyzeRule.AnalyzeByXPath
import io.legado.app.model.analyzeRule.AnalyzeByJSoup
import io.legado.app.model.analyzeRule.AnalyzeByJSonPath
import io.legado.app.model.analyzeRule.AnalyzeByRegex
import io.legado.app.model.analyzeRule.RuleAnalyzer
import java.net.URL
import java.net.URLEncoder
import java.net.URLDecoder
import java.lang.reflect.InvocationTargetException
import java.security.MessageDigest
import java.util.Base64
import java.util.regex.Pattern

private val gson = GsonBuilder().serializeNulls().disableHtmlEscaping().create()
internal class Unsupported(message: String) : RuntimeException(message)

private fun jdkStringCall(text: String, method: String, parameterTypes: Array<Class<*>>, arguments: Array<Any?>): Any {
    val target = java.lang.String::class.java.getMethod(method, *parameterTypes)
    return try {
        target.invoke(text, *arguments) as Any
    } catch (error: InvocationTargetException) {
        throw error.targetException
    }
}

private fun jdkStringCallVoid(text: String, method: String, parameterTypes: Array<Class<*>>, arguments: Array<Any?>) {
    val target = java.lang.String::class.java.getMethod(method, *parameterTypes)
    try {
        target.invoke(text, *arguments)
    } catch (error: InvocationTargetException) {
        throw error.targetException
    }
}

private fun jdkStringStaticCall(method: String, parameterTypes: Array<Class<*>>, arguments: Array<Any?>): Any {
    val target = java.lang.String::class.java.getMethod(method, *parameterTypes)
    return try {
        target.invoke(null, *arguments) as Any
    } catch (error: InvocationTargetException) {
        throw error.targetException
    }
}

private fun jdkChars(input: JsonObject): CharArray = input.getAsJsonArray("chars").map { it.asString.single() }.toCharArray()

private fun jdkStringType(name: String): Class<*> = when (name) {
    "String" -> java.lang.String::class.java
    "CharSequence" -> CharSequence::class.java
    "int" -> Int::class.javaPrimitiveType!!
    else -> error("Unsupported String parameter type: $name")
}

private fun execute(item: JsonObject): Any? {
    val input = item.getAsJsonObject("input")
    fun text(key: String) = input.get(key)?.asString ?: ""
    return when (val operation = item.get("operation").asString) {
        "request.redirect" -> redirectEvidence(input)
        "flow.mainJs" -> executeMainJsFlow(input)
        "flow.book" -> executeBookFlow(input)
        "flow.discover" -> executeBookFlow(input, discover = true)
        "flow.contentLifecycle" -> executeContentLifecycle(input)
        "flow.contentBatch" -> executeContentBatchFlow(input)
        "flow.loginHeader" -> executeLoginHeaderFlow(input)
        "flow.toc" -> executeBookFlow(input, tocOnly = true)
        "url.options" -> {
            val raw = text("url")
            val separator = Regex("\\s*,\\s*(?=\\{)").find(raw)
            if (separator == null) mapOf("url" to raw.trim(), "options" to null)
            else mapOf(
                "url" to raw.substring(0, separator.range.first).trim(),
                "options" to parseFlowUrlOptions(raw.substring(separator.range.last + 1).trim()),
            )
        }
        "rule.providerCrypto" -> providerCryptoEvidence(input)
        "rule.font" -> fontEvidence(input)
        "rule.legacyCrypto" -> legacyCryptoEvidence(input)
        "rule.zipDownload" -> zipDownloadEvidence(input)
        "rule.coverStream" -> coverStreamEvidence(input)
        "rule.infoMap" -> infoMapEvidence(input)
        "rule.cookieMap" -> cookieMapEvidence(input)
        "rule.dateBridge" -> dateBridgeEvidence(input)
        "rule.sourceState" -> sourceStateEvidence(input)
        "rule.scriptLibrary" -> scriptLibraryEvidence(input)
        "rule.bridgeObjects" -> bridgeReturnedObjects(input)
        "rule.bridgeContent" -> analyzeRuleSetContent(input)
        "rule.bridgeUrl" -> analyzeRuleUrlSetters(input)
        "rule.bridgeLocal" -> analyzeRuleLocalBindings(input)
        "rule.bridgeEvalJS" -> analyzeRuleEvalJS(input)
        "rule.bridgeString" -> analyzeRuleStringOverloads(input)
        "rule.bridgeElement" -> analyzeRuleGetElementNullability(input)
        "rule.bridgeElements" -> analyzeRuleGetElementsNullability(input)
        "rule.regexReplace" -> analyzeRuleRegexReplacement(input)
        "rule.split" -> RuleAnalyzer(text("rule"), input.get("code")?.asBoolean ?: false).splitRule(text("operator"))
        "rule.inner" -> RuleAnalyzer(text("rule"), true).innerRule("{$.") { path -> input.getAsJsonObject("values").get(path)?.asString }
        "regex.first" -> AnalyzeByRegex.getElement(text("text"), input.getAsJsonArray("patterns").map { it.asString }.toTypedArray())
        "regex.all" -> AnalyzeByRegex.getElements(text("text"), input.getAsJsonArray("patterns").map { it.asString }.toTypedArray())
        "string.api" -> {
            val value: Any = when (val method = text("method")) {
                "length" -> text("text").length
                "valueOfObject" -> jdkStringStaticCall("valueOf", arrayOf(Any::class.java), arrayOf(text("value")))
                "valueOfNumber" -> jdkStringStaticCall("valueOf", arrayOf(Any::class.java), arrayOf(input.get("number").asInt))
                "valueOfNull" -> jdkStringStaticCall("valueOf", arrayOf(Any::class.java), arrayOf(null))
                "valueOfChars" -> jdkStringStaticCall("valueOf", arrayOf(CharArray::class.java), arrayOf(if (input.get("nullChars")?.asBoolean == true) null else jdkChars(input)))
                "copyValueOf" -> jdkStringStaticCall(
                    "copyValueOf",
                    arrayOf(CharArray::class.java, Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!),
                    arrayOf(if (input.get("nullChars")?.asBoolean == true) null else jdkChars(input), input.get("offset").asInt, input.get("count").asInt),
                )
                "copyValueOfCaught" -> {
                    var caught = false
                    try {
                        jdkStringStaticCall(
                            "copyValueOf",
                            arrayOf(CharArray::class.java, Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!),
                            arrayOf(if (input.get("nullChars")?.asBoolean == true) null else jdkChars(input), input.get("offset").asInt, input.get("count").asInt),
                        )
                    } catch (_: IndexOutOfBoundsException) {
                        caught = true
                    }
                    mapOf("caught" to caught, "next" to jdkStringStaticCall("valueOf", arrayOf(CharArray::class.java), arrayOf(charArrayOf('o', 'k'))).toString().length)
                }
                "charAt" -> text("text")[input.get("index").asInt].toString()
                "substring" -> text("text").substring(input.get("index").asInt)
                "substringRange" -> text("text").substring(input.get("index").asInt, input.get("end").asInt)
                "contains" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    jdkStringCall(text("text"), "contains", arrayOf(jdkStringType("CharSequence")), arrayOf<Any?>(search))
                }
                "startsWith" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    if (input.has("index")) jdkStringCall(text("text"), "startsWith", arrayOf(jdkStringType("String"), jdkStringType("int")), arrayOf(search, input.get("index").asInt))
                    else jdkStringCall(text("text"), "startsWith", arrayOf(jdkStringType("String")), arrayOf<Any?>(search))
                }
                "endsWith" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    jdkStringCall(text("text"), "endsWith", arrayOf(jdkStringType("String")), arrayOf<Any?>(search))
                }
                "contentEquals" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    jdkStringCall(text("text"), "contentEquals", arrayOf(jdkStringType("CharSequence")), arrayOf<Any?>(search))
                }
                "indexOf" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    jdkStringCall(text("text"), "indexOf", arrayOf(jdkStringType("String")), arrayOf<Any?>(search))
                }
                "indexOfFrom" -> {
                    val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                    jdkStringCall(text("text"), "indexOf", arrayOf(jdkStringType("String"), jdkStringType("int")), arrayOf(search, input.get("index").asInt))
                }
                "lastIndexOf" -> {
                    val string = text("text")
                    if (input.has("codePoint")) {
                        val codePoint = input.get("codePoint").asInt
                        if (input.has("index")) jdkStringCall(string, "lastIndexOf", arrayOf(jdkStringType("int"), jdkStringType("int")), arrayOf(codePoint, input.get("index").asInt))
                        else jdkStringCall(string, "lastIndexOf", arrayOf(jdkStringType("int")), arrayOf(codePoint))
                    } else {
                        val search: String? = if (input.get("nullValue")?.asBoolean == true) null else text("value")
                        if (input.has("index")) jdkStringCall(string, "lastIndexOf", arrayOf(jdkStringType("String"), jdkStringType("int")), arrayOf(search, input.get("index").asInt))
                        else jdkStringCall(string, "lastIndexOf", arrayOf(jdkStringType("String")), arrayOf<Any?>(search))
                    }
                }
                "codePointAt" -> java.lang.String(text("text")).codePointAt(input.get("index").asInt)
                "codePointBefore" -> {
                    val string = java.lang.String(text("text"))
                    try {
                        string.codePointBefore(input.get("index").asInt)
                    } catch (error: IndexOutOfBoundsException) {
                        if (input.get("catchError")?.asBoolean == true) mapOf("caught" to "index-bounds", "next" to string.length) else throw error
                    }
                }
                "codePointCount" -> java.lang.String(text("text")).codePointCount(input.get("index").asInt, input.get("end").asInt)
                "offsetByCodePoints" -> java.lang.String(text("text")).offsetByCodePoints(input.get("index").asInt, input.get("end").asInt)
                "getChars" -> {
                    val string = text("text")
                    val begin = input.get("index").asInt
                    val end = input.get("end").asInt
                    val destinationIndex = input.get("destinationIndex").asInt
                    val destination = if (input.get("nullDestination")?.asBoolean == true) null else CharArray(input.get("destinationLength").asInt) { '?' }
                    jdkStringCallVoid(
                        string,
                        "getChars",
                        arrayOf(Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!, CharArray::class.java, Int::class.javaPrimitiveType!!),
                        arrayOf(begin, end, destination, destinationIndex),
                    )
                    val value = mapOf("chars" to destination?.concatToString(), "voidReturn" to true)
                    if (input.get("continue")?.asBoolean == true) mapOf("value" to value, "next" to string.codePointAt(end)) else value
                }
                "replace" -> java.lang.String(text("text")).replace(text("value") as CharSequence, text("replacement") as CharSequence).toString()
                "strip" -> java.lang.String(text("text")).strip().toString()
                "stripLeading" -> java.lang.String(text("text")).stripLeading().toString()
                "stripTrailing" -> java.lang.String(text("text")).stripTrailing().toString()
                "isBlank" -> java.lang.String(text("text")).isBlank()
                "getBytes" -> mapOf("type" to "bytes", "base64" to Base64.getEncoder().encodeToString(java.lang.String(text("text")).getBytes(text("charset").ifEmpty { "UTF-8" })))
                else -> throw Unsupported("未知 String 方法: $method")
            }
            if (text("method") == "getChars") value
            else if (input.get("continue")?.asBoolean == true) {
                val next = if (text("method") == "getBytes") java.lang.String(java.lang.String(text("text")).getBytes(text("charset").ifEmpty { "UTF-8" }), text("charset").ifEmpty { "UTF-8" }).toString() else value.toString().length
                mapOf("value" to value, "next" to next)
            } else value
        }
        "integer.parseInt", "integer.parseLongRadix", "integer.bigInteger" -> {
            val value: Any = when (operation) {
                "integer.parseInt" -> java.lang.Integer.parseInt(text("text"), input.get("radix").asInt)
                "integer.parseLongRadix" -> mapOf("type" to "integer", "decimal" to java.lang.Long.parseLong(text("text"), input.get("radix").asInt).toString())
                else -> java.math.BigInteger(text("text"), input.get("radix").asInt).toString(input.get("outRadix")?.asInt ?: 10)
            }
            if (input.get("continue")?.asBoolean == true) mapOf("value" to value, "next" to "v:${if (value is Map<*, *>) value["decimal"] else value}") else value
        }
        "collection.sequence" -> {
            val map = java.util.HashMap<String?, String?>()
            val list = java.util.ArrayList<String?>()
            var view: MutableList<String?> = list
            input.getAsJsonArray("actions").map { raw ->
                val action = JsonParser.parseString(raw.asString).asJsonArray
                fun value(index: Int): String? = if (action[index].isJsonNull) null else action[index].asString
                if (text("kind") == "map") when (action[0].asString) {
                    "put" -> map.put(value(1), value(2))
                    "get" -> map[value(1)]
                    "containsKey" -> map.containsKey(value(1))
                    "remove" -> map.remove(value(1))
                    "size" -> map.size
                    "clear" -> { map.clear(); null }
                    else -> throw Unsupported("未知 Map 操作")
                } else when (action[0].asString) {
                    "add" -> view.add(value(1))
                    "get" -> view[action[1].asInt]
                    "set" -> view.set(action[1].asInt, value(2))
                    "remove" -> view.removeAt(action[1].asInt)
                    "size" -> view.size
                    "subList" -> { view = view.subList(action[1].asInt, action[2].asInt); view.toList() }
                    "root" -> { view = list; view.toList() }
                    "rootSet" -> list.set(action[1].asInt, value(2))
                    "snapshot" -> view.toList()
                    "clear" -> { view.clear(); null }
                    else -> throw Unsupported("未知 List 操作")
                }
            }
        }
        "pattern.matcher" -> {
            val pattern = Pattern.compile(text("pattern"), input.get("flags")?.asInt ?: 0)
            val matcher = pattern.matcher(text("text"))
            input.getAsJsonArray("actions").map { raw ->
                val action = JsonParser.parseString(raw.asString).asJsonArray
                when (action[0].asString) {
                    "find" -> if (action.size() > 1) matcher.find(action[1].asInt) else matcher.find()
                    "matches" -> matcher.matches()
                    "lookingAt" -> matcher.lookingAt()
                    "group" -> if (action.size() < 2) matcher.group() else if (action[1].asJsonPrimitive.isString) matcher.group(action[1].asString) else matcher.group(action[1].asInt)
                    "start" -> if (action.size() < 2) matcher.start() else if (action[1].asJsonPrimitive.isString) matcher.start(action[1].asString) else matcher.start(action[1].asInt)
                    "end" -> if (action.size() < 2) matcher.end() else if (action[1].asJsonPrimitive.isString) matcher.end(action[1].asString) else matcher.end(action[1].asInt)
                    "region" -> { matcher.region(action[1].asInt, action[2].asInt); "region" }
                    "reset" -> { if (action.size() > 1) matcher.reset(action[1].asString) else matcher.reset(); "reset" }
                    "replaceAll" -> matcher.replaceAll(action[1].asString)
                    "replaceFirst" -> matcher.replaceFirst(action[1].asString)
                    "split" -> pattern.split(text("text"), if (action.size() > 1) action[1].asInt else 0).toList()
                    else -> throw Unsupported("未知 Matcher 操作")
                }
            }
        }
        "pattern.split" -> Pattern.compile(text("pattern")).split(text("text"), input.get("limit").asInt).toList()
        "string.split" -> java.lang.String(text("text")).split(text("pattern"), input.get("limit").asInt).toList()
        "string.replaceAll" -> java.lang.String(text("text")).replaceAll(text("pattern"), text("replacement"))
        "string.replaceFirst" -> java.lang.String(text("text")).replaceFirst(text("pattern"), text("replacement"))
        "pattern.quote" -> Pattern.quote(text("text"))
        "integer.parseLong" -> mapOf("type" to "integer", "decimal" to java.lang.Long.parseLong(text("text")).toString())
        "encoding.java64" -> {
            val value = if (text("action") == "encode") {
                val encoder = when (text("mode")) { "url" -> Base64.getUrlEncoder(); "mime" -> Base64.getMimeEncoder(); else -> Base64.getEncoder() }
                (if (input.get("padding")?.asBoolean == false) encoder.withoutPadding() else encoder).encodeToString(Base64.getDecoder().decode(text("text")))
            } else {
                val decoder = when (text("mode")) { "url" -> Base64.getUrlDecoder(); "mime" -> Base64.getMimeDecoder(); else -> Base64.getDecoder() }
                Base64.getEncoder().encodeToString(decoder.decode(text("text")))
            }
            if (input.get("continue")?.asBoolean == true) mapOf("value" to value, "next" to "v:$value") else value
        }
        "encoding.digest" -> {
            val digest = MessageDigest.getInstance(text("algorithm"))
            val value = Base64.getEncoder().encodeToString(digest.digest(Base64.getDecoder().decode(text("text"))))
            if (input.get("continue")?.asBoolean == true) mapOf("value" to value, "next" to Base64.getEncoder().encodeToString(digest.digest())) else value
        }
        "encoding.base64Encode" -> Base64.getEncoder().encodeToString(text("text").toByteArray(Charsets.UTF_8))
        "encoding.base64Decode" -> mapOf("type" to "bytes", "base64" to Base64.getEncoder().encodeToString(Base64.getDecoder().decode(text("text"))))
        "encoding.urlEncode" -> URLEncoder.encode(text("text"), text("charset").ifEmpty { "UTF-8" })
        "encoding.urlDecode" -> URLDecoder.decode(text("text"), text("charset").ifEmpty { "UTF-8" })
        "encoding.md5" -> MessageDigest.getInstance("MD5").digest(text("text").toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        "url.parts" -> {
            val url = if (input.has("base")) URL(URL(text("base")), text("url")) else URL(text("url"))
            mapOf("protocol" to url.protocol, "host" to url.host, "port" to url.port, "defaultPort" to url.defaultPort,
                "path" to url.path, "file" to url.file, "query" to url.query, "ref" to url.ref,
                "authority" to url.authority, "userInfo" to url.userInfo)
        }
        "xpath.string" -> AnalyzeByXPath(text("content")).getString(text("rule"))
        "xpath.list" -> AnalyzeByXPath(text("content")).getStringList(text("rule"))
        "xpath.nodes" -> AnalyzeByXPath(text("content")).getElements(text("rule"))?.map { node ->
            if (node.isElement) {
                val element = node.asElement()
                mapOf("kind" to "element", "tag" to element.tagName(), "text" to element.text(), "attribute" to element.attr(text("attribute")))
            } else {
                mapOf("kind" to "scalar", "value" to node.asString())
            }
        }
        "css.string" -> AnalyzeByJSoup(text("content")).getString(text("rule"))
        "css.list" -> AnalyzeByJSoup(text("content")).getStringList(text("rule"))
        "css.nodes" -> AnalyzeByJSoup(text("content")).getElements(text("rule")).map { node ->
            mapOf("tag" to node.tagName(), "text" to node.text(), "id" to node.id())
        }
        "corpus.cssString" -> {
            val content = text("content")
            val context = input.get("contextRule")?.asString?.let { AnalyzeByJSoup(content).getElements(it).first() }
            corpusCssString(text("rule"), context ?: content)
        }
        "corpus.script" -> {
            val result = corpusScriptRule(text("rule"), text("content"), input.get("nodes")?.asBoolean == true, text("custom"))
            // Android 的工作流与 Java bridge 调用同一个 AnalyzeRule 字段入口。
            mapOf("workflow" to result, "bridge" to result)
        }
        "chapter.number" -> io.legado.app.help.CorpusJsExtensions.toNumChapter(input.get("text")?.asString)
        "json.continue" -> { val parser = AnalyzeByJSonPath(text("content")); mapOf("first" to parser.getStringList(text("rule")), "next" to parser.getString(text("nextRule"))) }
        "json.read" -> {
            val config = Configuration.defaultConfiguration()
            if (input.get("pathFunction")?.asBoolean == true) {
                // Jayway 路径函数只能使用默认配置。单个返回值映射为适配器的单项结果序列。
                listOf(JsonPath.using(config).parse(text("content")).read<Any?>(text("rule")))
            } else {
                JsonPath.using(config.addOptions(Option.ALWAYS_RETURN_LIST)).parse(text("content")).read<Any>(text("rule"))
            }
        }
        "json.string" -> AnalyzeByJSonPath(text("content")).getString(text("rule"))
        "json.list" -> AnalyzeByJSonPath(text("content")).getStringList(text("rule"))
        else -> throw Unsupported("未注册的操作: $operation")
    }
}

fun main(args: Array<String>) {
    if (args.contentEquals(arrayOf("--test-join"))) {
        println(gson.toJson(listOf(
            android.text.TextUtils.join(",", emptyList<Any>()),
            android.text.TextUtils.join("|", listOf(null, "中文", "😀")),
            android.text.TextUtils.join("/", listOf(2, 1)),
            android.text.TextUtils.join(null, listOf("a", "b"))
        )))
        return
    }
    System.setProperty("file.encoding", "UTF-8")
    generateSequence(::readLine).forEach { line ->
        val item = JsonParser.parseString(line).asJsonObject
        val id = item.get("id").asString
        val result = try {
            mapOf("id" to id, "execution" to "completed", "outcome" to "return", "value" to execute(item))
        } catch (error: FlowFixtureError) {
            mapOf("id" to id, "execution" to "runner-failed", "reason" to error.message)
        } catch (error: Unsupported) {
            mapOf("id" to id, "execution" to "unsupported", "reason" to error.message)
        } catch (error: Throwable) {
            // 虚拟机资源故障属于执行器失败，不能伪装成被测函数的业务异常。
            if (error is VirtualMachineError || error is LinkageError || item.get("operation").asString.startsWith("flow.")) {
                mapOf("id" to id, "execution" to "runner-failed", "reason" to "${error.javaClass.name}: ${error.message}")
            } else {
                mapOf("id" to id, "execution" to "completed", "outcome" to "throw",
                    "error" to mapOf("class" to error.javaClass.name, "message" to (error.message ?: "")))
            }
        }
        // UTF-8 无法编码单独的代理代码单元，必须先写成 JSON Unicode 转义，避免变为问号。
        val json = gson.toJson(result)
        println(buildString {
            json.forEach { char ->
                if (char.code in 0xD800..0xDFFF) append("\\u%04x".format(char.code)) else append(char)
            }
        })
    }
}
