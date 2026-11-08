package io.legado.app.model.analyzeRule

import io.legado.app.data.entities.Book
import io.legado.app.data.entities.BookChapter
import io.legado.app.data.entities.BookSource
import kotlin.coroutines.CoroutineContext

/** Batch compatibility fixtures leave replaceRegex unset; unexpected execution fails closed. */
class AnalyzeRule(private val book: Book, private val source: BookSource) {
    fun setBaseUrl(baseUrl: String) = Unit
    fun getString(rule: String, content: String): String =
        error("fixture does not implement Android AnalyzeRule replacement: $rule")

    companion object {
        fun AnalyzeRule.setCoroutineContext(context: CoroutineContext) = Unit
        fun AnalyzeRule.setChapter(chapter: BookChapter) = Unit
    }
}
