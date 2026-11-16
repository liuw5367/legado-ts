package androidx.annotation

// 仅支持固定 Android 源码摘录中的编译期 IntDef 声明，不提供 Android 运行环境。
@Target(AnnotationTarget.ANNOTATION_CLASS)
@Retention(AnnotationRetention.SOURCE)
annotation class IntDef(vararg val value: Int, val flag: Boolean = false)
