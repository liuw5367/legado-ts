package io.legado.app.utils

import com.google.gson.GsonBuilder
import com.google.gson.JsonDeserializationContext
import com.google.gson.JsonDeserializer
import com.google.gson.JsonElement
import com.google.gson.ToNumberPolicy
import java.lang.reflect.Type
import java.net.URL

// 与锁定 Android GsonExtensions.kt 的 INITIAL_GSON 中 String/Int adapter 一致；本夹具不需要它的 Map/LocalDate adapter。
val GSON = GsonBuilder()
    .registerTypeAdapter(Int::class.java, IntJsonDeserializer())
    .registerTypeAdapter(String::class.java, StringJsonDeserializer())
    .setObjectToNumberStrategy(ToNumberPolicy.LONG_OR_DOUBLE)
    .disableHtmlEscaping()
    .create()

private class StringJsonDeserializer : JsonDeserializer<String?> {
    override fun deserialize(json: JsonElement, typeOfT: Type, context: JsonDeserializationContext?): String? = when {
        json.isJsonPrimitive -> json.asString
        json.isJsonNull -> null
        else -> json.toString()
    }
}

private class IntJsonDeserializer : JsonDeserializer<Int?> {
    override fun deserialize(json: JsonElement, typeOfT: Type?, context: JsonDeserializationContext?): Int? = when {
        json.isJsonPrimitive && json.asJsonPrimitive.isNumber -> json.asJsonPrimitive.asNumber.toInt()
        else -> null
    }
}

object NetworkUtils {
    // 目录夹具只使用 HTTP(S) 基准和普通相对章节路径。
    fun getAbsoluteURL(base: String, path: String): String = URL(URL(base), path).toString()
}

inline fun <reified T> com.google.gson.Gson.fromJsonObject(value: String?): Result<T?> =
    runCatching { fromJson(value, object : com.google.gson.reflect.TypeToken<T>() {}.type) }

fun String.toStringArray(): Array<String> = codePoints().mapToObj { String(Character.toChars(it)) }.toArray { arrayOfNulls<String>(it) }
