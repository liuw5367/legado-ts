package io.legado.app.data.entities

import io.legado.app.constant.BookType

// JVM 替代实体只保留本组 Gson 输入和实际规则脚本所用字段，排除 Room 和 Parcelable。
data class ContentRule(val replaceRegex: String? = null, val content: String = "")

data class BookSource(val bookSourceUrl: String, val bookSourceName: String, val customOrder: Int = 0) {
    var batchContentRule: ContentRule = ContentRule()
    fun getContentRule(): ContentRule = batchContentRule
}

class SearchBook {
    var bookUrl = ""
    var origin = ""
    var originName = ""
    var type = BookType.text
    var name = ""
    var author = ""
    var kind: String? = null
    var coverUrl: String? = null
    var intro: String? = null
    var wordCount: String? = null
    var latestChapterTitle: String? = null
    var tocUrl = ""
    var time = System.currentTimeMillis()
    var variable: String? = null
    var originOrder = 0
    var chapterWordCountText: String? = null
    var chapterWordCount = -1
    var respondTime = -1
    var infoHtml: String? = null
    var tocHtml: String? = null

    fun toBook() = Book().apply {
        bookUrl = this@SearchBook.bookUrl
        origin = this@SearchBook.origin
        originName = this@SearchBook.originName
        name = this@SearchBook.name
        author = this@SearchBook.author
        kind = this@SearchBook.kind
        wordCount = this@SearchBook.wordCount
        latestChapterTitle = this@SearchBook.latestChapterTitle
        coverUrl = this@SearchBook.coverUrl
        intro = this@SearchBook.intro
        tocUrl = this@SearchBook.tocUrl
        originOrder = this@SearchBook.originOrder
        type = this@SearchBook.type
        variable = this@SearchBook.variable
        infoHtml = this@SearchBook.infoHtml
        tocHtml = this@SearchBook.tocHtml
    }
}

class Book {
    var bookUrl = ""
    var origin = ""
    var originName = ""
    var originOrder = 0
    var tocUrl = ""
    var name = ""
    var fixtureFolder = "fixture-book"
    var isOnlineText = false
    var author = ""
    var intro: String? = null
    var coverUrl: String? = null
    var kind: String? = null
    var wordCount: String? = null
    var latestChapterTitle: String? = null
    var downloadUrls: List<String>? = null
    var type = BookType.text
    var variable: String? = null
    var infoHtml: String? = null
    var tocHtml: String? = null
    val variableMap = linkedMapOf<String, String>()

    fun getFolderName(): String = fixtureFolder
}

class BookChapter {
    var title = ""
    var url = ""
    var bookUrl = ""
    var baseUrl = ""
    var index = 0
    var isVolume = false
    var isVip = false
    var isPay = false
    fun getAbsoluteURL(): String = io.legado.app.utils.NetworkUtils.getAbsoluteURL(baseUrl, url)
}
