package io.legado.app.utils

import com.google.gson.GsonBuilder
import com.google.gson.ToNumberPolicy
import java.net.URL

val GSON = GsonBuilder().setObjectToNumberStrategy(ToNumberPolicy.LONG_OR_DOUBLE).disableHtmlEscaping().create()

object NetworkUtils {
    // 目录夹具只使用 HTTP(S) 基准和普通相对章节路径。
    fun getAbsoluteURL(base: String, path: String): String = URL(URL(base), path).toString()
}

inline fun <reified T> com.google.gson.Gson.fromJsonObject(value: String?): Result<T?> =
    runCatching { fromJson(value, object : com.google.gson.reflect.TypeToken<T>() {}.type) }

fun String.toStringArray(): Array<String> = codePoints().mapToObj { String(Character.toChars(it)) }.toArray { arrayOfNulls<String>(it) }
