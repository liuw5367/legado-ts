package io.legado.app.utils

import com.google.gson.GsonBuilder
import com.google.gson.ToNumberPolicy
import java.net.URL

val GSON = GsonBuilder().setObjectToNumberStrategy(ToNumberPolicy.LONG_OR_DOUBLE).disableHtmlEscaping().create()

object NetworkUtils {
    // 目录夹具只使用 HTTP(S) 基准和普通相对章节路径。
    fun getAbsoluteURL(base: String, path: String): String = URL(URL(base), path).toString()
}
