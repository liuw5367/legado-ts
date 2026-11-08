package io.legado.app.utils

import java.util.Base64

/** 对照 Android Base64.NO_WRAP，只适配对称加密类实际使用的字节重载。 */
object EncoderUtils {
    fun base64Encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
}
