package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.legado.app.help.CorpusJsExtensions
import org.htmlunit.corejs.javascript.Context
import java.util.Locale
import java.util.TimeZone

/** 通过 Rhino 调用锁定的 JsExtensions 日期方法，限定测试设备的默认 Locale/TimeZone。 */
internal class DateBridgeFacade {
    fun timeFormat(time: Long): String = CorpusJsExtensions.timeFormat(time)

    fun timeFormatUTC(time: Long, format: String, sh: Int): String? =
        CorpusJsExtensions.timeFormatUTC(time, format, sh)
}

internal fun dateBridgeEvidence(input: JsonObject): Any? {
    val originalLocale = Locale.getDefault()
    val originalTimeZone = TimeZone.getDefault()
    return try {
        Locale.setDefault(Locale.forLanguageTag(input.get("locale").asString))
        TimeZone.setDefault(TimeZone.getTimeZone(input.get("timeZone").asString))

        Context.enter().use { engine ->
            val scope = engine.initSafeStandardObjects()
            scope.put("java", scope, Context.javaToJS(DateBridgeFacade(), scope))
            val program = input.get("program").asString
            val script = "JSON.stringify((function(){\n$program\n})())"
            JsonParser.parseString(Context.toString(engine.evaluateString(scope, script, "date-bridge-fixture", 1, null)))
        }
    } finally {
        Locale.setDefault(originalLocale)
        TimeZone.setDefault(originalTimeZone)
    }
}
