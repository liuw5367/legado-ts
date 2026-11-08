package io.legado.app.help.book

import io.legado.app.data.entities.Book
import io.legado.app.data.entities.BookChapter
import io.legado.app.data.entities.BookSource

data class ContentSaveKey(val bookUrl: String, val chapterIndex: Int)
data class ContentSaveToken(val key: ContentSaveKey, val folderName: String, val version: Long)

/** 磁盘缓存替身；令牌版本检查与每次真实保存尝试均可被夹具观察。 */
object BatchContentMemorySink {
    data class Attempt(val index: Int, val content: String, val accepted: Boolean)

    private val versions = mutableMapOf<ContentSaveKey, Long>()
    private val attempts = mutableListOf<Attempt>()
    private var afterAcceptedSave: ((BookChapter) -> Unit)? = null

    @Synchronized
    fun reset() {
        versions.clear()
        attempts.clear()
        afterAcceptedSave = null
    }

    @Synchronized
    fun version(key: ContentSaveKey): Long = versions.getOrPut(key) { 1L }

    @Synchronized
    fun stale(token: ContentSaveToken) {
        versions[token.key] = token.version + 1
    }

    @Synchronized
    fun onAcceptedSave(callback: ((BookChapter) -> Unit)?) {
        afterAcceptedSave = callback
    }

    @Synchronized
    fun write(book: Book, chapter: BookChapter, content: String, token: ContentSaveToken): Boolean {
        val accepted = token.key.bookUrl == book.bookUrl && token.key.chapterIndex == chapter.index &&
            token.folderName == book.getFolderName() && token.version == version(token.key)
        attempts += Attempt(chapter.index, content, accepted)
        if (accepted) afterAcceptedSave?.invoke(chapter)
        return accepted
    }

    @Synchronized
    fun attempts(): List<Attempt> = attempts.toList()
}

object BookHelp {
    @Synchronized
    fun contentSaveToken(book: Book, chapter: BookChapter): ContentSaveToken {
        val key = ContentSaveKey(book.bookUrl, chapter.index)
        return ContentSaveToken(key, book.getFolderName(), BatchContentMemorySink.version(key))
    }

    fun saveContent(
        bookSource: BookSource,
        book: Book,
        bookChapter: BookChapter,
        content: String,
        token: ContentSaveToken,
    ): Boolean = BatchContentMemorySink.write(book, bookChapter, content, token)

    fun isContentSaveCurrent(token: ContentSaveToken): Boolean =
        BatchContentMemorySink.version(token.key) == token.version
}

val Book.isOnLineTxt: Boolean
    get() = isOnlineText
