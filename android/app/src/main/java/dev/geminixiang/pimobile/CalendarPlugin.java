package dev.geminixiang.pimobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.TimeZone;

/**
 * The phone's calendars through CalendarContract. Events are written straight into the calendar the tool names, so the
 * account is explicit; an ACTION_INSERT intent would land in whatever the calendar app defaults to, which on a phone
 * with work and personal accounts is easy to miss. The tool asks the user before writing.
 *
 * A calendar is the user's own when its owner is the account it syncs through. Others are subscriptions, such as a
 * team's shared calendar or a colleague's: often editable, and seen by everyone in it. They are never written to, and
 * their events are read only when asked for, so someone else's meetings are not taken for the user's.
 */
@CapacitorPlugin(
    name = "Calendar",
    permissions = { @Permission(strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }, alias = "calendar") }
)
public class CalendarPlugin extends Plugin {

    private boolean ensurePermission(PluginCall call, String callback) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) return true;
        requestPermissionForAlias("calendar", call, callback);
        return false;
    }

    @PluginMethod
    public void listCalendars(PluginCall call) {
        if (ensurePermission(call, "listResult")) list(call);
    }

    @PermissionCallback
    private void listResult(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) list(call);
        else call.reject("calendar permission denied", "permission");
    }

    /** A visible calendar, and whether it is the user's own and accepts new events. */
    private static final class CalendarRow {
        long id;
        String name;
        String account;
        String accountType;
        String owner;
        boolean primary;
        boolean own;
        boolean writable;
    }

    private java.util.List<CalendarRow> visibleCalendars() {
        String[] projection = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.ACCOUNT_TYPE,
            CalendarContract.Calendars.OWNER_ACCOUNT,
            CalendarContract.Calendars.IS_PRIMARY,
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
        };
        java.util.List<CalendarRow> rows = new java.util.ArrayList<>();
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor cursor = resolver.query(CalendarContract.Calendars.CONTENT_URI, projection, CalendarContract.Calendars.VISIBLE + " = 1", null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                CalendarRow row = new CalendarRow();
                row.id = cursor.getLong(0);
                row.name = cursor.getString(1);
                row.account = cursor.getString(2);
                row.accountType = cursor.getString(3);
                row.owner = cursor.getString(4);
                row.primary = !cursor.isNull(5) && cursor.getInt(5) == 1;
                row.own = row.account != null && row.account.equalsIgnoreCase(row.owner);
                row.writable = row.own && cursor.getInt(6) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;
                rows.add(row);
            }
        }
        return rows;
    }

    /** The user's own calendars that accept new events: the only ones events are ever added to. */
    private void list(PluginCall call) {
        JSArray calendars = new JSArray();
        for (CalendarRow row : visibleCalendars()) {
            if (!row.writable) continue;
            JSObject calendar = new JSObject();
            calendar.put("id", row.id);
            calendar.put("name", row.name);
            calendar.put("account", row.account);
            calendar.put("accountType", row.accountType);
            calendar.put("primary", row.primary);
            calendars.put(calendar);
        }
        JSObject result = new JSObject();
        result.put("calendars", calendars);
        call.resolve(result);
    }

    @PluginMethod
    public void listEvents(PluginCall call) {
        if (ensurePermission(call, "eventsResult")) events(call);
    }

    @PermissionCallback
    private void eventsResult(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) events(call);
        else call.reject("calendar permission denied", "permission");
    }

    /**
     * Event instances (recurrences expanded) overlapping [from, to), earliest first: from the user's own calendars, plus
     * the shared calendars when asked, marked as shared with their owner.
     */
    private void events(PluginCall call) {
        boolean includeShared = Boolean.TRUE.equals(call.getBoolean("includeShared", false));
        java.util.Map<Long, CalendarRow> calendars = new java.util.HashMap<>();
        for (CalendarRow row : visibleCalendars()) if (row.own || includeShared) calendars.put(row.id, row);
        Long from = call.getLong("from");
        Long to = call.getLong("to");
        if (from == null || to == null || to <= from) {
            call.reject("from and to are required, with to after from");
            return;
        }
        Uri.Builder range = CalendarContract.Instances.CONTENT_URI.buildUpon();
        android.content.ContentUris.appendId(range, from);
        android.content.ContentUris.appendId(range, to);
        String[] projection = {
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
        };
        String selection = CalendarContract.Instances.VISIBLE + " = 1 AND " + CalendarContract.Instances.STATUS + " != " + CalendarContract.Events.STATUS_CANCELED;
        JSArray events = new JSArray();
        try (Cursor cursor = getContext().getContentResolver().query(range.build(), projection, selection, null, CalendarContract.Instances.BEGIN + " ASC")) {
            while (cursor != null && cursor.moveToNext()) {
                // Declined invitations are not on the user's schedule.
                if (!cursor.isNull(9) && cursor.getInt(9) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue;
                CalendarRow calendar = calendars.get(cursor.getLong(8));
                if (calendar == null) continue;
                JSObject event = new JSObject();
                event.put("title", cursor.getString(0));
                event.put("begin", cursor.getLong(1));
                event.put("end", cursor.getLong(2));
                event.put("allDay", cursor.getInt(3) == 1);
                if (!cursor.isNull(4) && !cursor.getString(4).isEmpty()) event.put("location", cursor.getString(4));
                if (!cursor.isNull(5) && !cursor.getString(5).isEmpty()) {
                    String notes = cursor.getString(5);
                    event.put("notes", notes.length() > 400 ? notes.substring(0, 400) + "…" : notes);
                }
                event.put("calendar", calendar.name);
                event.put("account", calendar.account);
                event.put("accountType", calendar.accountType);
                event.put("calendarId", calendar.id);
                if (!calendar.own) {
                    event.put("shared", true);
                    event.put("owner", calendar.owner);
                }
                events.put(event);
            }
        }
        JSObject result = new JSObject();
        result.put("events", events);
        call.resolve(result);
    }

    /** Every visible calendar, for Settings to show accounts: whether it is the user's own and whether it takes events. */
    @PluginMethod
    public void listAccounts(PluginCall call) {
        if (ensurePermission(call, "accountsResult")) accounts(call);
    }

    @PermissionCallback
    private void accountsResult(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) accounts(call);
        else call.reject("calendar permission denied", "permission");
    }

    private void accounts(PluginCall call) {
        JSArray calendars = new JSArray();
        for (CalendarRow row : visibleCalendars()) {
            JSObject calendar = new JSObject();
            calendar.put("id", row.id);
            calendar.put("name", row.name);
            calendar.put("account", row.account);
            calendar.put("accountType", row.accountType);
            calendar.put("owner", row.owner);
            calendar.put("own", row.own);
            calendar.put("writable", row.writable);
            calendar.put("primary", row.primary);
            calendars.put(calendar);
        }
        JSObject result = new JSObject();
        result.put("calendars", calendars);
        call.resolve(result);
    }

    @PluginMethod
    public void insertEvent(PluginCall call) {
        if (ensurePermission(call, "insertResult")) insert(call);
    }

    @PermissionCallback
    private void insertResult(PluginCall call) {
        if (getPermissionState("calendar") == PermissionState.GRANTED) insert(call);
        else call.reject("calendar permission denied", "permission");
    }

    private void insert(PluginCall call) {
        Long calendarId = call.getLong("calendarId");
        Long begin = call.getLong("begin");
        Long end = call.getLong("end");
        if (calendarId == null || begin == null || end == null) {
            call.reject("calendarId, begin and end are required");
            return;
        }
        boolean allowed = false;
        for (CalendarRow row : visibleCalendars()) if (row.id == calendarId && row.writable) allowed = true;
        if (!allowed) {
            call.reject("calendar " + calendarId + " is not one of the user's own writable calendars", "not_allowed");
            return;
        }
        boolean allDay = Boolean.TRUE.equals(call.getBoolean("allDay", false));
        ContentValues values = new ContentValues();
        values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
        values.put(CalendarContract.Events.TITLE, call.getString("title", ""));
        values.put(CalendarContract.Events.DTSTART, begin);
        values.put(CalendarContract.Events.DTEND, end);
        values.put(CalendarContract.Events.ALL_DAY, allDay ? 1 : 0);
        // All-day events are stored at UTC midnight; TypeScript sends them that way.
        values.put(CalendarContract.Events.EVENT_TIMEZONE, allDay ? "UTC" : TimeZone.getDefault().getID());
        String location = call.getString("location");
        if (location != null) values.put(CalendarContract.Events.EVENT_LOCATION, location);
        String description = call.getString("description");
        if (description != null) values.put(CalendarContract.Events.DESCRIPTION, description);
        Uri uri = getContext().getContentResolver().insert(CalendarContract.Events.CONTENT_URI, values);
        if (uri == null) {
            call.reject("the calendar provider did not create the event");
            return;
        }
        JSObject result = new JSObject();
        result.put("id", Long.parseLong(uri.getLastPathSegment()));
        call.resolve(result);
    }
}
