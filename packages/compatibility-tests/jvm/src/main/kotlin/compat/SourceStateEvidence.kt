package compat

import com.google.gson.JsonObject
import java.util.Base64

/** CacheManager 的数据库和 ACache 使用内存替代，保留 CacheManager 和 BaseSource 的真实键语义。 */
internal fun sourceStateEvidence(input: JsonObject): Any {
    val kind = input.get("kind").asString
    val key = input.get("key").asString
    val value = input.get("value").asString
    val bytes = Base64.getDecoder().decode(input.get("bytes").asString)
    val cache = mutableMapOf<String, String>()
    val binary = mutableMapOf<String, ByteArray>()
    val first = "https://fixture.invalid"
    val second = "https://second.fixture.invalid"
    val variableKey = "sourceVariable_$first"
    val sourceKey = "v_${first}_$key"

    fun observe(source: String): Map<String, Any?> {
        val variable = cache["sourceVariable_$source"]
        return mapOf(
            "cached" to cache[key],
            "bytes" to binary[key]?.map { it.toInt() and 0xff },
            "variable" to (variable ?: ""),
            "storedVariable" to variable,
            "key" to (cache["v_${source}_$key"] ?: ""),
        )
    }

    val missing = observe(first)
    cache[key] = ""
    binary[key] = bytes
    cache[variableKey] = ""
    val empty = observe(first)
    cache[key] = value
    cache[variableKey] = value
    cache[sourceKey] = value
    val overwritten = observe(first)
    if (kind == "isolation") {
        return mapOf("first" to overwritten, "other" to observe(second), "unchanged" to observe(first))
    }
    if (kind != "roundtrip") throw Unsupported("未知源状态案例")
    // Android 通过持久层重新读取既有值。Node 的快照格式只在 TS 侧执行。
    val restored = observe(first)
    cache.remove(key)
    binary.remove(key)
    cache.remove(variableKey)
    return mapOf(
        "missing" to missing,
        "empty" to empty,
        "overwritten" to overwritten,
        "restored" to restored,
        "deleted" to observe(first),
    )
}
