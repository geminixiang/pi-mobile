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

    /** Visible calendars the user can add events to. */
    private void list(PluginCall call) {
        String[] projection = {
            CalendarContract.Calendars._ID,
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME,
            CalendarContract.Calendars.ACCOUNT_TYPE,
            CalendarContract.Calendars.IS_PRIMARY,
        };
        String selection =
            CalendarContract.Calendars.VISIBLE + " = 1 AND " +
            CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + " >= " + CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR;
        JSArray calendars = new JSArray();
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor cursor = resolver.query(CalendarContract.Calendars.CONTENT_URI, projection, selection, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                JSObject calendar = new JSObject();
                calendar.put("id", cursor.getLong(0));
                calendar.put("name", cursor.getString(1));
                calendar.put("account", cursor.getString(2));
                calendar.put("accountType", cursor.getString(3));
                calendar.put("primary", !cursor.isNull(4) && cursor.getInt(4) == 1);
                calendars.put(calendar);
            }
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
