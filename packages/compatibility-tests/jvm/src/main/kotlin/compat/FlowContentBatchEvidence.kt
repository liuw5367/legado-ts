package compat

import com.google.gson.JsonObject
import io.legado.app.data.entities.Book
import io.legado.app.data.entities.BookChapter
import io.legado.app.data.entities.BookSource
import io.legado.app.data.entities.ContentRule
import io.legado.app.help.CorpusJsExtensions
import io.legado.app.help.book.BatchContentMemorySink
import io.legado.app.help.book.BookHelp
import io.legado.app.help.book.ContentSaveToken
import io.legado.app.model.BatchContentContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.Function
import org.jsoup.Jsoup
import java.util.Base64

/**
 * 固定上游 BookContent/CacheBook 的顺序，直接执行锁定的 BatchContentContext 和
 * JsExtensions.cacheContent 方法。磁盘缓存替换为带版本令牌的内存 sink。
 */
internal fun executeContentBatchFlow(input: JsonObject): Any {
    BatchContentMemorySink.reset()
    val sourceJson = input.getAsJsonObject("source")
    val bookJson = input.getAsJsonObject("book")
    val chapterRows = input.getAsJsonObject("chapters").getAsJsonArray("items")
    val faultJson = input.getAsJsonObject("faults")
    val sourceUrl = sourceJson.get("bookSourceUrl").asString
    val ruleContent = sourceJson.getAsJsonObject("ruleContent")
    val source = BookSource(sourceUrl, sourceJson.get("bookSourceName")?.asString.orEmpty()).apply {
        batchContentRule = ContentRule(ruleContent?.get("replaceRegex")?.asString, ruleContent?.get("content")?.asString.orEmpty())
    }
    val book = Book().apply {
        bookUrl = bookJson.get("bookUrl").asString
        tocUrl = bookJson.get("tocUrl")?.asString ?: ""
        name = bookJson.get("name")?.asString ?: ""
        fixtureFolder = bookJson.get("folderName")?.asString ?: "fixture-book"
        isOnlineText = bookJson.get("isOnlineText")?.asBoolean ?: false
    }
    val chapters = chapterRows.map { row ->
        val value = row.asJsonObject
        BookChapter().apply {
            bookUrl = book.bookUrl
            index = value.get("index").asInt
            title = value.get("title").asString
            url = value.get("url").asString
            baseUrl = value.get("baseUrl")?.asString ?: book.tocUrl.ifBlank { sourceUrl }
        }
    }
    val tokens: Map<Int, ContentSaveToken> = chapters.associate { it.index to BookHelp.contentSaveToken(book, it) }
    val job = Job()
    faultJson?.getAsJsonArray("staleIndexes")?.forEach { index ->
        tokens[index.asInt]?.let(BatchContentMemorySink::stale)
    }
    val cancelAfterIndex = faultJson?.get("cancelAfterIndex")?.takeUnless { it.isJsonNull }?.asInt
    BatchContentMemorySink.onAcceptedSave { chapter ->
        if (chapter.index == cancelAfterIndex) job.cancel(CancellationException("fixture cancellation"))
    }
    val context = BatchContentContext(source, book, chapters, job, tokens)
    CorpusJsExtensions.attachBatchContext(context, job)
    val mode = input.get("mode").asString
    val program = input.get("program").asString
    var batchOutcome = "success"
    try {
        Context.enter().use { engine ->
            val scope = engine.initSafeStandardObjects()
            val jsChapters = engine.newArray(scope, chapters.map { Context.javaToJS(it, scope) }.toTypedArray<Any>())
            val jsBook = Context.javaToJS(book, scope)
            scope.put("java", scope, Context.javaToJS(CorpusJsExtensions, scope))
            scope.put("chapters", scope, jsChapters)
            scope.put("book", scope, jsBook)
            if (mode == "declarative") {
                val scripts = splitBatchScripts(program)
                for ((index, code) in scripts.withIndex()) {
                    engine.evaluateString(scope, code, "android-content-batch-$index", 1, null)
                }
            } else {
                engine.evaluateString(scope, program, "android-js-source-content-batch", 1, null)
                val function = scope.get("getContentBatch", scope) as? Function
                if (function == null) {
                    batchOutcome = "missing-function"
                } else {
                    engine.evaluateString(scope, "getContentBatch(chapters, book)", "android-js-source-content-batch-call", 1, null)
                }
            }
        }
        job.ensureActive()
    } catch (_: CancellationException) {
        batchOutcome = "cancelled"
    } catch (_: Throwable) {
        batchOutcome = if (job.isCancelled) "cancelled" else "failed"
    } finally {
        context.close()
        CorpusJsExtensions.attachBatchContext(null)
        BatchContentMemorySink.onAcceptedSave(null)
    }

    val attempts = BatchContentMemorySink.attempts().toMutableList()
    val savedIndexes = attempts.filter { it.accepted }.mapTo(linkedSetOf()) { it.index }
    val savedContent = linkedMapOf<Int, String>()
    attempts.filter { it.accepted }.forEach { savedContent[it.index] = it.content }
    val batchAttemptedIndexes = attempts.mapTo(linkedSetOf()) { it.index }
    val requestItems = mutableListOf<String>()
    val fallbackSucceeded = linkedSetOf<Int>()
    val responses = input.getAsJsonObject("responses")
    if (batchOutcome != "cancelled") {
        for (chapter in context.missingChapters()) {
            val token = tokens.getValue(chapter.index)
            // CacheBook skips fallback after another operation invalidates the batch token.
            if (!BookHelp.isContentSaveCurrent(token)) continue
            val url = chapter.getAbsoluteURL()
            if (requestItems.size >= input.get("requestLimit").asInt) {
                throw FlowFixtureError("批量正文离线请求超限: $url")
            }
            val response = responses.entrySet().firstOrNull { (_, entry) ->
                entry.asJsonObject.get("url").asString == url
            }?.value?.asJsonObject ?: throw FlowFixtureError("批量正文离线夹具缺少单章响应: $url")
            requestItems += url
            val base64 = response.getAsJsonObject("response").get("base64").asString
            val html = String(Base64.getDecoder().decode(base64), Charsets.UTF_8)
            val content = Jsoup.parse(html).body().text()
            if (content.isNotBlank()) {
                val saved = BookHelp.saveContent(source, book, chapter, content, token)
                attempts += BatchContentMemorySink.attempts().last()
                if (saved) {
                    savedIndexes += chapter.index
                    savedContent[chapter.index] = content
                    fallbackSucceeded += chapter.index
                }
            }
        }
    }

    val items = chapters.map { chapter ->
        val via = when {
            chapter.index in fallbackSucceeded -> "single"
            chapter.index in savedIndexes -> "batch"
            chapter.index in batchAttemptedIndexes -> "batch"
            else -> "none"
        }
        linkedMapOf<String, Any>(
            "index" to chapter.index,
            "saved" to (chapter.index in savedIndexes),
            "via" to via,
        ).also { item -> savedContent[chapter.index]?.let { item["content"] = it } }
    }
    val hasContent = items.any { it.containsKey("content") }
    val unresolved = items.any { !it.getValue("saved").toString().toBoolean() && !it.containsKey("content") }
    val cacheRejected = attempts.any { !it.accepted }
    val status = when {
        batchOutcome == "cancelled" -> "cancelled"
        unresolved || cacheRejected -> if (hasContent) "partial" else "failed"
        else -> "success"
    }
    return mapOf(
        "status" to status,
        "batchCount" to if (chapters.size > 1) 1 else 0,
        "batchOutcome" to batchOutcome,
        "items" to items,
        "requests" to requestItems,
        "writes" to attempts.map { mapOf("index" to it.index, "content" to it.content, "accepted" to it.accepted) },
    )
}

private fun splitBatchScripts(program: String): List<String> {
    val trimmed = program.trim()
    if (trimmed.startsWith("@js:", ignoreCase = true)) return listOf(trimmed.substring(4))
    if (!trimmed.startsWith("<js>", ignoreCase = true)) return listOf(trimmed)
    val matches = Regex("(?is)<js>(.*?)</js>").findAll(trimmed).toList()
    if (matches.isEmpty() || matches.joinToString("") { it.value }.replace(Regex("\\s+"), "") != trimmed.replace(Regex("\\s+"), "")) {
        throw IllegalArgumentException("批量规则夹具的 <js> 分段不完整")
    }
    return matches.map { it.groupValues[1] }
}
