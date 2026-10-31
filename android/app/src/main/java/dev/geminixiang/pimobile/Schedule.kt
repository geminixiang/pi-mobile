package dev.geminixiang.pimobile

import java.time.LocalTime
import java.time.ZonedDateTime
import org.json.JSONObject

private const val MISSED_GRACE_MS = 6 * 60 * 60 * 1000L
private const val LATE_FIRE_MS = 5_000L

internal data class Schedule(val id: String, val name: String, val avatar: String?, val trigger: When) {
    companion object {
        fun of(json: JSONObject) = Schedule(json.getString("id"), json.getString("name"), json.stringOrNull("avatar"), When.of(json.getJSONObject("when")))
    }
}

internal data class Window(val days: Set<Int>, val from: LocalTime?, val until: LocalTime?, val gapHours: Int) {
    fun contains(now: ZonedDateTime): Boolean {
        if (days.isNotEmpty() && now.dayOfWeek.value !in days) return false
        if (from == null && until == null) return true
        val time = now.toLocalTime()
        val start = from ?: LocalTime.MIN
        val end = until ?: LocalTime.MAX
        return if (start.isAfter(end)) !time.isBefore(start) || time.isBefore(end) else !time.isBefore(start) && time.isBefore(end)
    }
}

internal sealed interface When {
    data class Daily(val time: LocalTime, val days: Set<Int>) : When

    data class Once(val at: Long) : When

    sealed interface Event : When {
        val window: Window
    }

    data class Headphones(override val window: Window) : Event

    data class Charging(override val window: Window) : Event

    data class Unlock(override val window: Window) : Event

    data class BatteryLow(override val window: Window) : Event

    data class Timezone(override val window: Window) : Event

    data class Wifi(val ssid: String?, override val window: Window) : Event

    data class Notification(val app: String?, val contains: String?, override val window: Window) : Event

    data class Photo(val album: String?, override val window: Window) : Event

    data class Bluetooth(val connect: Boolean, val device: String, override val window: Window) : Event

    data class Activity(val start: Boolean, val activity: String, override val window: Window) : Event

    data class Place(val arrive: Boolean, val label: String, val latitude: Double, val longitude: Double, val radius: Float, override val window: Window) : Event

    companion object {
        fun of(json: JSONObject): When {
            val kind = json.getString("kind")
            if (kind == "once") return Once(json.getLong("at"))
            val days = json.getJSONArray("days").let { list -> (0 until list.length()).map(list::getInt).toSet() }
            if (kind == "daily") return Daily(LocalTime.parse(json.getString("time")), days)
            val window = Window(days, json.stringOrNull("from")?.let(LocalTime::parse), json.stringOrNull("until")?.let(LocalTime::parse), maxOf(1, json.getInt("gapHours")))
            return when (kind) {
                "headphones" -> Headphones(window)
                "charging" -> Charging(window)
                "unlock" -> Unlock(window)
                "battery_low" -> BatteryLow(window)
                "timezone" -> Timezone(window)
                "wifi" -> Wifi(json.stringOrNull("ssid"), window)
                "notification" -> Notification(json.stringOrNull("app"), json.stringOrNull("contains"), window)
                "photo" -> Photo(json.stringOrNull("album"), window)
                "bluetooth" -> Bluetooth(json.getString("on") == "connect", json.getString("device"), window)
                "activity" -> Activity(json.getString("on") == "start", json.getString("activity"), window)
                "place" -> Place(json.getString("on") == "arrive", json.getString("label"), json.getDouble("latitude"), json.getDouble("longitude"), json.getDouble("radius").toFloat(), window)
                else -> throw IllegalArgumentException("unknown schedule kind $kind")
            }
        }
    }
}

internal fun When.nextTime(now: ZonedDateTime): Long? {
    val nowMs = now.toInstant().toEpochMilli()
    return when (this) {
        is When.Once -> if (at > nowMs) at else if (at > nowMs - MISSED_GRACE_MS) nowMs + LATE_FIRE_MS else null
        is When.Daily ->
            generateSequence(now.with(time).withSecond(0).withNano(0)) { it.plusDays(1).with(time) }
                .take(8)
                .firstOrNull { it.toInstant().toEpochMilli() > nowMs && (days.isEmpty() || it.dayOfWeek.value in days) }
                ?.toInstant()
                ?.toEpochMilli()
        is When.Event -> null
    }
}

internal fun JSONObject.stringOrNull(field: String): String? = if (has(field) && !isNull(field)) getString(field).takeIf { it.isNotEmpty() } else null
