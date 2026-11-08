package android.text

/** 仅供固定上游 XPath 参考源码的文本拼接适配。 */
object TextUtils {
    @JvmStatic
    fun join(delimiter: CharSequence?, tokens: Iterable<*>): String = tokens.joinToString(delimiter.toString()) { it.toString() }

    @JvmStatic
    fun isEmpty(value: CharSequence?): Boolean = value == null || value.isEmpty()
}
