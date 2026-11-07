package compat

import com.google.gson.JsonObject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runBlocking

/** 离线编排 WebBook / BookContent 的请求和副文边界，使用与上游同版本的真实协程。 */
internal fun executeContentLifecycle(input: JsonObject): Any = runBlocking {
    val fault = input.get("fault").asString
    val requests = mutableListOf<String>()
    val requestStarted = CompletableDeferred<Unit>()
    var active = 0
    var titleEvaluated = false
    var auxiliarySaved = false
    var auxiliaryFailure = false

    suspend fun request(stage: String): String {
        requests += stage
        active++
        try {
            return when {
                stage == "chapter" && fault != "primary-cancel" -> input.get("chapterBody").asString
                stage == "lyrics" && fault == "auxiliary-failure" -> error("离线副文请求失败")
                else -> {
                    requestStarted.complete(Unit)
                    awaitCancellation()
                }
            }
        } finally {
            active--
        }
    }

    val chapter = async {
        val body = request("chapter")
        currentCoroutineContext().ensureActive()
        // BookContent 捕获副文网络异常，继续处理标题；外层 Deferred 仍能观察真实取消。
        runCatching {
            request("lyrics")
            auxiliarySaved = true
        }.onFailure {
            auxiliaryFailure = true
        }
        titleEvaluated = true
        body
    }
    if (fault != "auxiliary-failure") {
        requestStarted.await()
        chapter.cancel()
    }
    val delivered = try {
        chapter.await()
    } catch (_: CancellationException) {
        null
    }
    chapter.join()
    mapOf(
        "status" to if (delivered == null) "cancelled" else "success",
        "delivered" to delivered,
        "requests" to requests,
        "active" to active,
        "titleEvaluated" to titleEvaluated,
        "auxiliarySaved" to auxiliarySaved,
        "auxiliaryFailure" to auxiliaryFailure,
    )
}
