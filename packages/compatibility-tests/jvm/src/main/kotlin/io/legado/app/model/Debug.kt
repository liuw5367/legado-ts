package io.legado.app.model

object Debug {
    fun log(sourceUrl: String, message: String) {
        System.err.println("$sourceUrl $message")
    }
}
