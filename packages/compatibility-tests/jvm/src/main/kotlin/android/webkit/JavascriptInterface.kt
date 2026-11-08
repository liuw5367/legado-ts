package android.webkit

/** 构建期注解替身；该兼容夹具不启动 Android WebView。 */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.BINARY)
annotation class JavascriptInterface
