package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.htmlunit.corejs.javascript.Context

/** 只隔离 Android CookieStore 的纯 Map 转换；Cookie 数据库与 HTTP 栈由夹具提供。 */
class CookieMapBridge(initialCookie: String) {
    private var currentCookie = initialCookie
    private var requestCookie: String? = null

    fun cookieToMap(cookie: String): MutableMap<String, String> = CookieMapReference.cookieToMap(cookie)

    fun mapToCookie(cookieMap: Map<String, String>?): String? = CookieMapReference.mapToCookie(cookieMap)

    fun getCookie(url: String): String = currentCookie

    fun replaceCookie(url: String, cookie: String) {
        if (url.isEmpty() || cookie.isEmpty()) return
        currentCookie = CookieMapReference.mergeCookieValues(currentCookie, cookie)
    }

    fun ajax(url: String): String {
        requestCookie = currentCookie
        return "fixture response"
    }

    fun lastRequestCookie(): String? = requestCookie
}

internal fun cookieMapEvidence(input: JsonObject): Any {
    val bridge = CookieMapBridge(input.get("oldCookie")?.asString ?: "")
    return Context.enter().use { engine ->
        val scope = engine.initSafeStandardObjects()
        scope.put("cookie", scope, Context.javaToJS(bridge, scope))
        scope.put("java", scope, Context.javaToJS(bridge, scope))
        scope.put("cookieText", scope, input.get("cookie")?.asString ?: "")
        scope.put("newCookie", scope, input.get("newCookie")?.asString ?: "")
        scope.put("url", scope, input.get("url")?.asString ?: "https://fixture.invalid/probe")

        val script = when (input.get("kind").asString) {
            "convert" -> """
                var map = cookie.cookieToMap(cookieText);
                var keys = [], values = [], iterator = map.keySet().iterator();
                while (iterator.hasNext()) { var key = String(iterator.next()); keys.push(key); values.push(map.get(key)); }
                JSON.stringify({keys:keys,values:values,size:map.size(),emptyPresent:map.containsKey(""),prototypePresent:map.containsKey("__proto__"),constructorPresent:map.containsKey("constructor"),cookie:cookie.mapToCookie(map)})
            """.trimIndent()
            "merge-request" -> """
                cookie.replaceCookie(url, newCookie);
                java.ajax(url);
                JSON.stringify({cookie:cookie.getCookie(url),requestCookie:java.lastRequestCookie()})
            """.trimIndent()
            else -> throw Unsupported("未知 Cookie Map 案例")
        }
        JsonParser.parseString(Context.toString(engine.evaluateString(scope, script, "cookie-map-fixture", 1, null)))
    }
}
