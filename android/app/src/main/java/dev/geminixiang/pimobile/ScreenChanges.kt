package dev.geminixiang.pimobile

internal class ScreenChanges {
    private val times = java.util.concurrent.ConcurrentHashMap<Int, Long>()

    fun record(display: Int, at: Long) { times[display] = at }

    fun pending(display: Int, since: Long, start: Long, now: Long, cap: Long): Boolean {
        val last = times[display] ?: 0L
        return now - start < cap && ((last <= since && now - start < 1000L) || now - last < 350L)
    }
}
