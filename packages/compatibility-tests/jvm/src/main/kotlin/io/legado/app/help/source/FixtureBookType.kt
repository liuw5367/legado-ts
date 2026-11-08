package io.legado.app.help.source

import io.legado.app.constant.BookType
import io.legado.app.data.entities.BookSource

// 整源流程夹具使用文本书源。
fun BookSource.getBookType(): Int = BookType.text
