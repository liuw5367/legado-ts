package io.legado.app.utils

// 参考端只把调试输出送到 stderr，协议结果使用 stdout。
fun Throwable.printOnDebug() {
    System.err.println("${javaClass.name}: $message")
}
