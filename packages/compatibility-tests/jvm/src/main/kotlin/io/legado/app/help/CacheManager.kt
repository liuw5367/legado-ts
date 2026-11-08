package io.legado.app.help

/** InfoMap 的 JVM 缓存边界，用固定时钟保留 Android 的秒级到期条件。 */
object CacheManager {
    private data class Entry(val value: String, val expiresAt: Long)
    private val values = mutableMapOf<String, Entry>()
    var now = 0L
    var lastSaveTime: Int? = null
        private set

    fun get(key: String): String? = values[key]?.takeIf { it.expiresAt == 0L || it.expiresAt > now }?.value

    fun put(key: String, value: String, saveTime: Int) {
        lastSaveTime = saveTime
        values[key] = Entry(value, if (saveTime == 0) 0L else now + saveTime * 1000L)
    }

    fun put(key: String, value: String) = put(key, value, 0)

    fun delete(key: String) { values.remove(key) }

    fun reset() {
        values.clear()
        now = 0
        lastSaveTime = null
    }
}
