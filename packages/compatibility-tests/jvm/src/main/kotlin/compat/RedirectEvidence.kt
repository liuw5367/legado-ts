package compat

import com.google.gson.JsonObject
import com.sun.net.httpserver.HttpServer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.CopyOnWriteArrayList

internal fun redirectEvidence(input: JsonObject): Any {
    val status = input.get("status").asInt
    val crossOrigin = input.get("crossOrigin").asBoolean
    val missingLocation = input.get("missingLocation")?.asBoolean == true
    val requests = CopyOnWriteArrayList<Map<String, Any?>>()
    val servers = mutableListOf<HttpServer>()
    val client = OkHttpClient.Builder().proxy(Proxy.NO_PROXY).build()
    fun listen(route: String, redirect: String? = null): String {
        val server = try {
            HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        } catch (error: IOException) {
            throw FlowFixtureError("无法监听重定向夹具: ${error.message}")
        }
        servers.add(server)
        server.createContext(route) { exchange ->
            exchange.use {
                requests.add(mapOf(
                    "path" to exchange.requestURI.path,
                    "method" to exchange.requestMethod,
                    "body" to exchange.requestBody.readAllBytes().toString(Charsets.UTF_8),
                    "userAgent" to exchange.requestHeaders.getFirst("User-Agent"),
                    "authorization" to exchange.requestHeaders.getFirst("Authorization"),
                    "cookie" to exchange.requestHeaders.getFirst("Cookie"),
                    "contentType" to exchange.requestHeaders.getFirst("Content-Type"),
                ))
                val location = redirect?.takeIf { exchange.requestURI.path == "/start" }
                if (location != null && !missingLocation) exchange.responseHeaders.set("Location", location)
                exchange.sendResponseHeaders(if (location != null) status else 200, -1)
            }
        }
        server.start()
        return "http://127.0.0.1:${server.address.port}"
    }
    try {
        val target = if (crossOrigin) listen("/target") else ""
        val origin = listen("/", "$target/target")
        val request = Request.Builder().url("$origin/start")
            .header("User-Agent", "fixture-redirect")
            .header("Authorization", "Bearer fixture")
            .header("Cookie", "session=fixture")
            .post("fixture body".toRequestBody("text/plain; charset=utf-8".toMediaType())).build()
        return client.newCall(request).execute().use { response ->
            mapOf("status" to response.code, "finalPath" to response.request.url.encodedPath, "requests" to requests)
        }
    } finally {
        servers.forEach { it.stop(0) }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }
}
