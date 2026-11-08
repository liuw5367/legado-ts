package compat

import com.google.gson.JsonObject
import io.legado.app.help.CacheManager
import io.legado.app.utils.GSON
import io.legado.app.utils.InfoMap
import org.htmlunit.corejs.javascript.Context

internal fun infoMapEvidence(input: JsonObject): Any {
    val source = "https://infomap.fixture.invalid"
    CacheManager.reset()
    try {
        CacheManager.put("infoMap_$source", GSON.toJson(input.getAsJsonObject("initial")), 0)
        val info = InfoMap(source)
        fun execute(script: String): String = Context.enter().use { engine ->
            val scope = engine.initSafeStandardObjects()
            scope.put("infoMap", scope, Context.javaToJS(info, scope))
            Context.toString(engine.evaluateString(scope, script, "infoMap-fixture", 1, null))
        }
        execute(input.get("action").asString)
        val live = info.toMap()
        val beforeCommit = InfoMap(source).toMap()
        val needSave = info.needSave
        if (needSave) info.saveNow()
        val afterCommit = InfoMap(source).toMap()
        val seconds = CacheManager.lastSaveTime ?: 0
        CacheManager.now = (seconds * 1000L - 1).coerceAtLeast(0)
        val beforeExpiry = InfoMap(source).toMap()
        CacheManager.now = seconds * 1000L
        return mapOf(
            "live" to live, "beforeCommit" to beforeCommit, "needSave" to needSave,
            "afterCommit" to afterCommit, "beforeExpiry" to beforeExpiry, "afterExpiry" to InfoMap(source).toMap(),
            "savedSeconds" to seconds, "requestUrl" to source + execute(input.get("category").asString),
        )
    } finally {
        CacheManager.reset()
    }
}
