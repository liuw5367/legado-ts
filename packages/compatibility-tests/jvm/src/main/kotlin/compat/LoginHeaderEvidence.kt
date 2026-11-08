package compat

import com.google.gson.JsonObject
import io.legado.app.help.CacheManager

/** 直接执行锁定的 BaseSource/AnalyzeUrl 摘录，只替换数据库、持久 Cookie 和网络传输边界。 */
internal fun executeLoginHeaderFlow(input: JsonObject): Any {
    val sourceInput = input.getAsJsonObject("source")
    val sourceUrl = sourceInput.get("bookSourceUrl").asString
    val source = AndroidLoginSource(sourceUrl, sourceInput.get("header").asString)
    val targets = input.getAsJsonArray("targets")

    CacheManager.reset()
    AndroidCookieStoreExcerpt.reset()
    AndroidCookieStoreExcerpt.seed(sourceUrl, input.get("initialCookie").asString)
    source.putLoginHeader(input.get("loginHeader").asString)

    fun observe(targetUrl: String, explicitHeaders: Map<String, String> = emptyMap(), currentSource: AndroidLoginSource = source): Map<String, String?> {
        val gate = AndroidLoginHeaderGateExcerpt(currentSource, sourceUrl)
        val headers = currentSource.getHeaderMap(gate.includesLoginHeader(targetUrl))
        // AnalyzeUrl 在构造时先合并 URL options headers，executeStrRequest 再运行 setCookie。
        headers.putAll(explicitHeaders)
        val storedCookie = AndroidCookieStoreExcerpt.getCookie(targetUrl)
        if (storedCookie.isNotEmpty()) {
            headers["Cookie"] = AndroidCookieStoreExcerpt.mergeCookieValues(storedCookie, headers["Cookie"].orEmpty())
        }
        return mapOf(
            "authorization" to headers.entries.firstOrNull { it.key.equals("Authorization", true) }?.value,
            "cookie" to headers.entries.firstOrNull { it.key == "Cookie" }?.value,
        )
    }

    val requests = targets.map { raw ->
        val target = raw.asJsonObject
        val options = target.getAsJsonObject("headers")?.entrySet()?.associate { it.key to it.value.asString }.orEmpty()
        mapOf("name" to target.get("name").asString, "headers" to observe(target.get("url").asString, options))
    }
    val storedHeader = source.getLoginHeader()
    val cookieAfterPut = AndroidCookieStoreExcerpt.getCookie(sourceUrl).ifEmpty { null }

    // BaseSource 从 CacheManager 读取同一 source key；新对象代表新运行会话。
    val restoredSource = AndroidLoginSource(sourceUrl, source.header)
    val restoredTarget = targets[1].asJsonObject
    val restored = mapOf(
        "header" to restoredSource.getLoginHeader(),
        "request" to observe(restoredTarget.get("url").asString, currentSource = restoredSource),
    )
    restoredSource.removeLoginHeader()
    val deleted = mapOf(
        "header" to restoredSource.getLoginHeader(),
        "cookie" to AndroidCookieStoreExcerpt.getCookie(sourceUrl).ifEmpty { null },
        "request" to observe(targets[0].asJsonObject.get("url").asString, currentSource = restoredSource),
    )

    val variants = input.getAsJsonObject("variants").getAsJsonArray("cases").map { raw ->
        val variant = raw.asJsonObject
        CacheManager.reset()
        AndroidCookieStoreExcerpt.reset()
        val initial = variant.get("initialCookie").asString
        AndroidCookieStoreExcerpt.seed(sourceUrl, initial)
        val current = AndroidLoginSource(sourceUrl, source.header)
        current.putLoginHeader(variant.get("loginHeader").asString)
        val loginMap = current.getLoginHeaderMap()?.toMap()
        mapOf(
            "name" to variant.get("name").asString,
            "stored" to current.getLoginHeader(),
            "loginHeaders" to loginMap,
            "cookie" to AndroidCookieStoreExcerpt.getCookie(sourceUrl).ifEmpty { null },
        )
    }

    CacheManager.reset()
    AndroidCookieStoreExcerpt.reset()
    return mapOf(
        "stored" to storedHeader,
        "cookieAfterPut" to cookieAfterPut,
        "requests" to requests,
        "restored" to restored,
        "deleted" to deleted,
        "variants" to variants,
    )
}
