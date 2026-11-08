package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.legado.app.constant.BookType
import io.legado.app.data.entities.Book
import io.legado.app.data.entities.BookSource
import io.legado.app.data.entities.SearchBook
import io.legado.app.exception.NoStackTraceException
import io.legado.app.model.jsSource.JsSourceMarshaller
import org.htmlunit.corejs.javascript.BaseFunction
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.Function
import org.htmlunit.corejs.javascript.Scriptable
import org.htmlunit.corejs.javascript.Undefined
import org.htmlunit.corejs.javascript.VarScope
import java.net.URL
import java.util.Base64

/** 纯 JVM 保留固定 Rhino 和原 marshaller，应用作用域和网络仅适配已声明的离线输入。 */
internal fun executeMainJsFlow(input: JsonObject): Any {
    val definition = input.getAsJsonObject("source")
    val source = BookSource(definition.get("bookSourceUrl").asString, definition.get("bookSourceName").asString)
    val requests = mutableListOf<Map<String, String>>()
    val stages = linkedMapOf<String, Any?>()
    val output = mapOf("stages" to stages, "requests" to requests)
    var fault: FlowFixtureError? = null
    fun stage(name: String, status: String, value: Any?) {
        stages[name] = mapOf("status" to status, "value" to value)
    }
    fun call(name: String, bindings: Map<String, Any?>, optional: Boolean = false): String? = Context.enter().use { engine ->
        val scope = engine.initSafeStandardObjects()
        scope.put("baseUrl", scope, source.bookSourceUrl)
        for ((key, value) in bindings) scope.put(key, scope, Context.javaToJS(value, scope))
        val java = engine.newObject(scope)
        java.put("ajax", java, object : BaseFunction() {
            override fun call(cx: Context, scope: VarScope, thisObj: Scriptable, args: Array<Any>): Any {
                val url = URL(URL(source.bookSourceUrl), Context.toString(args[0])).toString()
                val fixture = input.getAsJsonObject("responses").entrySet().map { it.value.asJsonObject }
                    .singleOrNull { it.get("url").asString == url && it.get("method").asString == "GET" && it.get("body").isJsonNull }
                if (fixture == null || requests.size >= input.get("requestLimit").asInt) {
                    val error = FlowFixtureError("整源 JS 缺少请求夹具: $name $url")
                    fault = error
                    throw error
                }
                requests.add(mapOf("method" to "GET", "url" to url))
                return Base64.getDecoder().decode(fixture.getAsJsonObject("response").get("base64").asString).toString(Charsets.UTF_8)
            }
        })
        scope.put("java", scope, java)
        engine.evaluateString(scope, definition.get("mainJs").asString, "mainJs", 1, null)
        if (scope.get(name, scope) !is Function) {
            if (optional) return@use null
            throw NoStackTraceException("JS源缺少函数 $name")
        }
        val result = engine.evaluateString(scope, "$name(${bindings.keys.joinToString(",")})", name, 1, null)
        fault?.let { throw it }
        if (result == null || result is Undefined) return@use null
        if (result is CharSequence) return@use result.toString()
        scope.put("fixtureResult", scope, result)
        Context.toString(engine.evaluateString(scope, "JSON.stringify(fixtureResult)", "normalize", 1, null))
    }
    fun <T> execute(name: String, run: () -> T): T? = try {
        run()
    } catch (error: Exception) {
        fault?.let { throw it }
        if (error is FlowFixtureError) throw error
        stage(name, "failed", null)
        null
    }
    val rows = execute("search") {
        JsSourceMarshaller.parseSearchBooks(call("search", linkedMapOf("key" to input.get("keyword").asString, "page" to 1)), source)
    } ?: return output
    fun delivered(name: String, books: List<SearchBook>) {
        stage(name, if (books.isEmpty()) "empty" else "delivered", books.map {
            buildMap {
                put("name", it.name)
                put("bookUrl", it.bookUrl)
                put("type", it.type)
                put("variable", it.variable)
                if (input.get("searchBookEvidence")?.asBoolean == true) {
                    put("author", it.author)
                    put("kind", it.kind)
                    put("intro", it.intro)
                    put("coverUrl", it.coverUrl)
                    put("wordCount", it.wordCount)
                    put("latestChapterTitle", it.latestChapterTitle)
                    put("tocUrl", it.tocUrl)
                }
            }
        })
    }
    delivered("search", rows)
    val first = rows.firstOrNull() ?: return output
    val found = execute("discover") {
        JsSourceMarshaller.parseSearchBooks(call("explore", linkedMapOf("url" to "/category", "page" to 1)), source)
    } ?: return output
    delivered("discover", found)
    val book = execute("detail") {
        val selectedBook = first.toBook().apply { type = BookType.text }
        JsSourceMarshaller.mergeBookInfo(selectedBook, call("getBookInfo", mapOf("book" to selectedBook), optional = true), source, false)
        if (selectedBook.tocUrl.isBlank()) selectedBook.tocUrl = selectedBook.bookUrl
        selectedBook
    } ?: return output
    fun variables() = book.variable?.let { JsonParser.parseString(it) }
    stage("detail", "success", mapOf("name" to book.name, "bookUrl" to book.bookUrl, "tocUrl" to book.tocUrl,
        "type" to book.type, "intro" to book.intro, "variable" to variables()))
    book.type = (book.type and BookType.allBookType.inv()) or BookType.text
    val chapters = execute("toc") { JsSourceMarshaller.parseChapters(call("getChapters", mapOf("book" to book)), book, source) }
        ?: return output
    if (chapters.isEmpty()) {
        stage("toc", "failed", null)
        return output
    }
    stage("toc", "success", chapters.map {
        mapOf("title" to it.title, "url" to it.url, "index" to it.index, "volume" to it.isVolume, "vip" to it.isVip, "pay" to it.isPay)
    })
    val index = input.get("chapterIndex").asInt
    val chapter = chapters.getOrNull(index) ?: throw FlowFixtureError("整源 JS 缺少指定章节")
    val next = chapters[(index + 1) % chapters.size].url
    val content = execute("content") {
        if (chapter.isVolume && chapter.url.startsWith(chapter.title)) ""
        else call("getContent", linkedMapOf("chapter" to chapter, "book" to book, "nextChapterUrl" to next)).orEmpty()
    }
    if (content != null) stage("content", if (content.isNotBlank()) "success" else if (chapter.isVolume) "empty" else "failed",
        content.takeUnless { it.isBlank() && !chapter.isVolume })
    return output + ("variableAfterContent" to variables())
}
