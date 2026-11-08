package compat

import com.google.gson.JsonObject
import org.htmlunit.corejs.javascript.BaseFunction
import org.htmlunit.corejs.javascript.Context
import org.htmlunit.corejs.javascript.Scriptable
import org.htmlunit.corejs.javascript.VarScope
import org.htmlunit.corejs.javascript.Wrapper
import java.io.ByteArrayInputStream
import java.util.Base64

class FixtureCoverInput(bytes: ByteArray) : ByteArrayInputStream(bytes) {
    var closeCalls = 0
        private set

    override fun close() {
        closeCalls++
        super.close()
    }
}

internal fun coverStreamEvidence(input: JsonObject): Any = Context.enter().use { engine ->
    engine.languageVersion = Context.VERSION_ES6
    engine.setClassShutter { it in setOf(FixtureCoverInput::class.java.name, ByteArray::class.java.name) }
    val scope = engine.initSafeStandardObjects()
    val stream = FixtureCoverInput(Base64.getDecoder().decode(input.get("bytes").asString))
    val java = engine.newObject(scope)
    fun bind(name: String, callback: (Array<Any>) -> Any?) {
        java.put(name, java, object : BaseFunction() {
            override fun call(cx: Context, scope: VarScope, thisObj: Scriptable, args: Array<Any>): Any? = callback(args)
        })
    }
    bind("base64DecodeToByteArray") { args ->
        Context.javaToJS(Base64.getDecoder().decode(Context.toString(args[0])), scope)
    }
    var logs = 0
    bind("log") { args ->
        if (Context.toString(args[0]) == "input-closed") logs++
        null
    }
    scope.put("java", scope, java)
    scope.put("result", scope, Context.javaToJS(stream, scope))
    scope.put("src", scope, input.get("src").asString)
    // ImageUtils 将脚本返回的 ByteArray 包成输出流，失败则返回 null。
    val output = runCatching {
        val value = engine.evaluateString(scope, input.get("script").asString, "cover-fixture", 1, null)
        val bytes = (value as Wrapper).unwrap() as ByteArray
        ByteArrayInputStream(bytes).use { it.readAllBytes() }
    }.onFailure { System.err.println("封面参考脚本异常：${it.javaClass.simpleName}: ${it.message}") }.getOrNull()
    check(logs == stream.closeCalls) { "脚本的 close 记录与 JVM 实际调用次数不一致" }
    mapOf(
        "status" to if (output == null) "failed" else "success",
        "bytes" to output?.let(Base64.getEncoder()::encodeToString),
        "inputCloseCalls" to stream.closeCalls,
    )
}
