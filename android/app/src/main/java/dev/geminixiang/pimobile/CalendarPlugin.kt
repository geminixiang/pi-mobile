package dev.geminixiang.pimobile

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.net.Uri
import android.provider.CalendarContract
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.util.TimeZone

@CapacitorPlugin(
    name = "Calendar",
    permissions = [Permission(strings = [Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR], alias = "calendar")],
)
class CalendarPlugin : Plugin() {
    private class CalendarRow(
        val id: Long,
        val name: String?,
        val account: String?,
        val accountType: String?,
        val owner: String?,
        val primary: Boolean,
        val own: Boolean,
        val writable: Boolean,
    )

    private fun visibleCalendars(): List<CalendarRow> {
        val projection =
            arrayOf(
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME,
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.OWNER_ACCOUNT,
                CalendarContract.Calendars.IS_PRIMARY,
                CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
            )
        val cursor =
            context.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, projection, CalendarContract.Calendars.VISIBLE + " = 1", null, null)
                ?: return emptyList()
        return cursor.use {
            buildList {
                while (cursor.moveToNext()) {
                    val account = cursor.getString(2)
                    val owner = cursor.getString(4)
                    val own = account != null && account.equals(owner, ignoreCase = true)
                    add(
                        CalendarRow(
                            id = cursor.getLong(0),
                            name = cursor.getString(1),
                            account = account,
                            accountType = cursor.getString(3),
                            owner = owner,
                            primary = !cursor.isNull(5) && cursor.getInt(5) == 1,
                            own = own,
                            writable = own && cursor.getInt(6) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR,
                        ),
                    )
                }
            }
        }
    }

    @PluginMethod
    fun listEvents(call: PluginCall) =
        Background.run(call) {
            val includeShared = call.getBoolean("includeShared", false) == true
            val calendars = visibleCalendars().filter { it.own || includeShared }.associateBy { it.id }
            val args = call.data
            val from = args.optLong("from")
            val to = args.optLong("to")
            if (!args.has("from") || !args.has("to") || to <= from) {
                call.reject("from and to are required, with to after from")
                return@run
            }
            val range = CalendarContract.Instances.CONTENT_URI.buildUpon()
            ContentUris.appendId(range, from)
            ContentUris.appendId(range, to)
            val projection =
                arrayOf(
                    CalendarContract.Instances.TITLE,
                    CalendarContract.Instances.BEGIN,
                    CalendarContract.Instances.END,
                    CalendarContract.Instances.ALL_DAY,
                    CalendarContract.Instances.EVENT_LOCATION,
                    CalendarContract.Instances.DESCRIPTION,
                    CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
                    CalendarContract.Instances.OWNER_ACCOUNT,
                    CalendarContract.Instances.CALENDAR_ID,
                    CalendarContract.Instances.SELF_ATTENDEE_STATUS,
                    CalendarContract.Instances.EVENT_ID,
                )
            val status = CalendarContract.Instances.STATUS
            val selection =
                CalendarContract.Instances.VISIBLE + " = 1 AND (" + status + " IS NULL OR " + status + " != " + CalendarContract.Events.STATUS_CANCELED + ")"
            val events = JSArray()
            context.contentResolver.query(range.build(), projection, selection, null, CalendarContract.Instances.BEGIN + " ASC")?.use { cursor ->
                while (cursor.moveToNext()) {
                    if (!cursor.isNull(9) && cursor.getInt(9) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue
                    val calendar = calendars[cursor.getLong(8)] ?: continue
                    val event = JSObject()
                    event.put("id", cursor.getLong(10).toString())
                    event.put("title", cursor.getString(0).orEmpty())
                    event.put("begin", cursor.getLong(1))
                    event.put("end", cursor.getLong(2))
                    event.put("allDay", cursor.getInt(3) == 1)
                    cursor.getString(4)?.takeIf { it.isNotEmpty() }?.let { event.put("location", it) }
                    cursor.getString(5)?.takeIf { it.isNotEmpty() }?.let { notes ->
                        event.put("notes", if (notes.length > 400) notes.take(400) + "…" else notes)
                    }
                    event.put("calendar", calendar.name.orEmpty())
                    event.put("account", calendar.account.orEmpty())
                    event.put("accountType", calendar.accountType.orEmpty())
                    event.put("calendarId", calendar.id)
                    if (!calendar.own) {
                        event.put("shared", true)
                        event.put("owner", calendar.owner.orEmpty())
                    }
                    events.put(event)
                }
            }
            call.resolve(JSObject().put("events", events))
        }

    @PluginMethod
    fun listAccounts(call: PluginCall) =
        Background.run(call) {
            val calendars = JSArray()
            visibleCalendars().forEach { row ->
                val calendar = JSObject()
                calendar.put("id", row.id)
                calendar.put("name", row.name.orEmpty())
                calendar.put("account", row.account.orEmpty())
                calendar.put("accountType", row.accountType.orEmpty())
                calendar.put("owner", row.owner.orEmpty())
                calendar.put("own", row.own)
                calendar.put("writable", row.writable)
                calendar.put("primary", row.primary)
                calendars.put(calendar)
            }
            call.resolve(JSObject().put("calendars", calendars))
        }

    @PluginMethod
    fun insertEvent(call: PluginCall) =
        Background.run(call) {
            val args = call.data
            if (!args.has("calendarId") || !args.has("begin") || !args.has("end")) {
                call.reject("calendarId, begin and end are required")
                return@run
            }
            val calendarId = args.optLong("calendarId")
            val begin = args.optLong("begin")
            val end = args.optLong("end")
            if (visibleCalendars().none { it.id == calendarId && it.writable }) {
                call.reject("calendar $calendarId is not one of the user's own writable calendars", "not_allowed")
                return@run
            }
            val allDay = call.getBoolean("allDay", false) == true
            val values = ContentValues()
            values.put(CalendarContract.Events.CALENDAR_ID, calendarId)
            values.put(CalendarContract.Events.TITLE, call.getString("title", ""))
            values.put(CalendarContract.Events.DTSTART, begin)
            values.put(CalendarContract.Events.DTEND, end)
            values.put(CalendarContract.Events.ALL_DAY, if (allDay) 1 else 0)
            values.put(CalendarContract.Events.EVENT_TIMEZONE, if (allDay) "UTC" else TimeZone.getDefault().id)
            call.getString("location")?.let { values.put(CalendarContract.Events.EVENT_LOCATION, it) }
            call.getString("description")?.let { values.put(CalendarContract.Events.DESCRIPTION, it) }
            val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            if (uri == null) {
                call.reject("the calendar provider did not create the event")
                return@run
            }
            call.resolve(JSObject().put("id", uri.lastPathSegment.orEmpty().toLong()))
        }

    @PluginMethod
    fun deleteEvent(call: PluginCall) =
        Background.run(call) {
            val args = call.data
            val id = args.optString("id")
            if (id.isEmpty() || !id.all { it in '0'..'9' } || !args.has("begin")) {
                call.reject("a numeric event id and begin are required")
                return@run
            }
            val eventId = id.toLong()
            val begin = args.optLong("begin")
            val all = args.optBoolean("all")
            val resolver = context.contentResolver
            val projection = arrayOf(CalendarContract.Events.CALENDAR_ID, CalendarContract.Events.RRULE, CalendarContract.Events.RDATE, CalendarContract.Events.ORIGINAL_ID)
            val event = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId)
            val found =
                resolver.query(event, projection, CalendarContract.Events.DELETED + " = 0", null, null)?.use { cursor ->
                    if (!cursor.moveToFirst()) null else Triple(cursor.getLong(0), !cursor.isNull(1) || !cursor.isNull(2), cursor.getString(3))
                }
            if (found == null) {
                call.reject("there is no event $id", "not_found")
                return@run
            }
            val (calendarId, recurring, series) = found
            if (visibleCalendars().none { it.id == calendarId && it.writable }) {
                call.reject("event $id is not on one of the user's own writable calendars", "not_allowed")
                return@run
            }
            val canceled = ContentValues()
            canceled.put(CalendarContract.Events.STATUS, CalendarContract.Events.STATUS_CANCELED)
            val done =
                when {
                    series != null && all -> resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, series.toLong()), null, null) > 0
                    series != null -> resolver.update(event, canceled, null, null) > 0
                    recurring && !all -> {
                        canceled.put(CalendarContract.Events.ORIGINAL_INSTANCE_TIME, begin)
                        resolver.insert(Uri.withAppendedPath(CalendarContract.Events.CONTENT_EXCEPTION_URI, id), canceled) != null
                    }
                    else -> resolver.delete(event, null, null) > 0
                }
            if (!done) {
                call.reject("the calendar provider did not delete event $id")
                return@run
            }
            call.resolve(JSObject().put("repeating", recurring || series != null))
        }
}
