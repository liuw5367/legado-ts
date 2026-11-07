package compat

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.script.ScriptBindings
import org.htmlunit.corejs.javascript.Context
import java.security.MessageDigest
import java.util.HexFormat
import java.util.TimeZone

internal fun scriptLibraryEvidence(input: JsonObject): Any {
    val kind = input.get("kind").asString
    val library = input.get("library").asString
    val program = input.get("program").asString
    val libraryHash = MessageDigest.getInstance("MD5").digest(library.toByteArray(Charsets.UTF_8))
    val prefix = "${HexFormat.of().formatHex(libraryHash)}:"
    return Context.enter().use { engine ->
        engine.languageVersion = Context.VERSION_ES6
        engine.timeZone = TimeZone.getTimeZone("UTC")
        engine.setClassShutter { false }

        fun loadLibrary(): ScriptBindings = ScriptBindings().also { scope ->
            engine.evaluateString(scope, library, "fixture-library", 1, null)
            scope.globalThis.preventExtensions()
        }

        var libraryScope = loadLibrary()
        fun evaluate(sourceKey: String): Any {
            val scope = ScriptBindings()
            scope.chainTo(libraryScope, ScriptBindings.getSharedGlobalStateHandle("$prefix$sourceKey"))
            val value = engine.evaluateString(scope, program, "fixture-script", 1, null)
            return JsonParser.parseString(Context.toString(value))
        }

        try {
            when (kind) {
                "date" -> evaluate("a")
                "scope", "peer-refresh" -> {
                    val beforeRefresh = listOf(evaluate("a"), evaluate("a"), evaluate("b"))
                    // SharedJsScope.remove 用库摘要前缀使来源状态失效，并丢弃缓存库作用域。
                    ScriptBindings.removeSharedGlobalStates(prefix)
                    libraryScope = loadLibrary()
                    beforeRefresh + evaluate(if (kind == "scope") "a" else "b")
                }
                else -> throw Unsupported("未知 jsLib 案例")
            }
        } finally {
            ScriptBindings.removeSharedGlobalStates(prefix)
        }
    }
}
