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
    return Context.enter().use { engine ->
        engine.languageVersion = Context.VERSION_ES6
        engine.timeZone = TimeZone.getTimeZone("UTC")
        engine.setClassShutter { false }

        fun prefix(sourceLibrary: String): String {
            val hash = MessageDigest.getInstance("MD5").digest(sourceLibrary.toByteArray(Charsets.UTF_8))
            return "${HexFormat.of().formatHex(hash)}:"
        }

        val libraryScopes = mutableMapOf<String, ScriptBindings>()
        val sourceVariables = mutableMapOf<String, String>()
        var cacheValue = "0"

        fun loadLibrary(sourceLibrary: String): ScriptBindings = ScriptBindings().also { scope ->
            engine.evaluateString(scope, sourceLibrary, "fixture-library", 1, null)
            scope.globalThis.preventExtensions()
        }

        fun libraryScope(sourceLibrary: String): ScriptBindings {
            val key = prefix(sourceLibrary)
            return libraryScopes.getOrPut(key) { loadLibrary(sourceLibrary) }
        }

        fun removeLibrary(sourceLibrary: String) {
            val key = prefix(sourceLibrary)
            ScriptBindings.removeSharedGlobalStates(key)
            libraryScopes.remove(key)
        }

        fun evaluate(sourceKey: String, sourceLibrary: String = library): Any {
            val scope = ScriptBindings()
            val stateKey = "${prefix(sourceLibrary)}$sourceKey"
            scope.chainTo(libraryScope(sourceLibrary), ScriptBindings.getSharedGlobalStateHandle(stateKey))
            if (kind == "peer-refresh") {
                scope.put("__fixtureSourceValue", sourceVariables[sourceKey] ?: "0")
                scope.put("__fixtureCacheValue", cacheValue)
                engine.evaluateString(
                    scope,
                    "var java = {get:function(key){return String(key)==='fixtureVariable'?__fixtureSourceValue:'';},put:function(key,value){if(String(key)==='fixtureVariable')__fixtureSourceValue=String(value);return String(value);}}; " +
                        "var cache = {get:function(key){return String(key)==='fixtureCache'?__fixtureCacheValue:null;},put:function(key,value){if(String(key)==='fixtureCache')__fixtureCacheValue=String(value);return String(value);}};",
                    "fixture-host-bridge",
                    1,
                    null,
                )
            }
            val value = engine.evaluateString(scope, program, "fixture-script", 1, null)
            val result = JsonParser.parseString(Context.toString(value))
            if (kind == "peer-refresh") {
                sourceVariables[sourceKey] = result.asJsonObject.get("sourceValue").asString
                cacheValue = result.asJsonObject.get("cacheValue").asString
            }
            return result
        }

        try {
            when (kind) {
                "date" -> evaluate("a")
                "closure" -> {
                    val beforeRefresh = listOf(evaluate("a"), evaluate("a"))
                    removeLibrary(library)
                    beforeRefresh + evaluate("a")
                }
                "peer-refresh" -> {
                    val differentLibrary = "$library\n// distinct library"
                    val beforeRefresh = listOf(
                        evaluate("a"),
                        evaluate("a"),
                        evaluate("b"),
                        evaluate("c", differentLibrary),
                        evaluate("c", differentLibrary),
                    )
                    // SharedJsScope.remove(jsLib) uses the raw library digest, so a different library keeps its scope and state.
                    removeLibrary(library)
                    beforeRefresh + listOf(evaluate("a"), evaluate("b"), evaluate("c", differentLibrary))
                }
                "scope" -> {
                    val beforeRefresh = listOf(evaluate("a"), evaluate("a"), evaluate("b"))
                    // SharedJsScope.remove 用库摘要前缀使来源状态失效，并丢弃缓存库作用域。
                    removeLibrary(library)
                    beforeRefresh + evaluate("a")
                }
                else -> throw Unsupported("未知 jsLib 案例")
            }
        } finally {
            (libraryScopes.keys + prefix(library)).forEach(ScriptBindings::removeSharedGlobalStates)
        }
    }
}
