package androidx.annotation

// 仅满足源码中的构建期注解引用，不提供 Android 运行环境。
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY)
@Retention(AnnotationRetention.BINARY)
annotation class Keep
