package dev.geminixiang.pimobile;

import android.Manifest;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.provider.ContactsContract.PhoneLookup;
import android.provider.Telephony;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.HashMap;
import java.util.Map;

@CapacitorPlugin(
    name = "Records",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CALL_LOG }, alias = "calls"),
        @Permission(strings = { Manifest.permission.READ_SMS }, alias = "sms")
    }
)
public class RecordsPlugin extends Plugin {

    private boolean ensure(PluginCall call, String alias, String callback) {
        if (getPermissionState(alias) == PermissionState.GRANTED) return true;
        if (!TriggersPlugin.inFront(getActivity())) {
            call.reject("pi has no " + alias + " permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.");
            return false;
        }
        requestPermissionForAlias(alias, call, callback);
        return false;
    }

    @PluginMethod
    public void calls(PluginCall call) {
        if (ensure(call, "calls", "callsResult")) readCalls(call);
    }

    @PermissionCallback
    private void callsResult(PluginCall call) {
        if (getPermissionState("calls") == PermissionState.GRANTED) readCalls(call);
        else call.reject("call log permission denied", "permission");
    }

    private void readCalls(PluginCall call) {
        long since = call.getLong("since", 0L);
        int limit = call.getInt("limit", 50);
        String[] columns = { CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION };
        JSArray items = new JSArray();
        try (Cursor cursor = getContext().getContentResolver().query(
            CallLog.Calls.CONTENT_URI, columns, CallLog.Calls.DATE + " >= " + since, null, CallLog.Calls.DATE + " DESC"
        )) {
            while (cursor != null && cursor.moveToNext() && items.length() < limit) {
                JSObject item = new JSObject();
                item.put("number", cursor.getString(0));
                String name = cursor.getString(1);
                if (name == null || name.isEmpty()) name = contactName(cursor.getString(0));
                if (name != null) item.put("name", name);
                item.put("type", callType(cursor.getInt(2)));
                item.put("time", cursor.getLong(3));
                item.put("seconds", cursor.getLong(4));
                items.put(item);
            }
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    private static String callType(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:
                return "incoming";
            case CallLog.Calls.OUTGOING_TYPE:
                return "outgoing";
            case CallLog.Calls.MISSED_TYPE:
                return "missed";
            case CallLog.Calls.REJECTED_TYPE:
                return "rejected";
            case CallLog.Calls.BLOCKED_TYPE:
                return "blocked";
            case CallLog.Calls.VOICEMAIL_TYPE:
                return "voicemail";
            default:
                return "other";
        }
    }

    @PluginMethod
    public void sms(PluginCall call) {
        if (ensure(call, "sms", "smsResult")) readSms(call);
    }

    @PermissionCallback
    private void smsResult(PluginCall call) {
        if (getPermissionState("sms") == PermissionState.GRANTED) readSms(call);
        else call.reject("SMS permission denied", "permission");
    }

    private void readSms(PluginCall call) {
        long since = call.getLong("since", 0L);
        int limit = call.getInt("limit", 50);
        String query = call.getString("query", "");
        String where = Telephony.Sms.DATE + " >= " + since + (query.isEmpty() ? "" : " AND (" + Telephony.Sms.BODY + " LIKE ? OR " + Telephony.Sms.ADDRESS + " LIKE ?)");
        String[] args = query.isEmpty() ? null : new String[] { "%" + query + "%", "%" + query + "%" };
        String[] columns = { Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ };
        Map<String, String> names = new HashMap<>();
        JSArray items = new JSArray();
        try (Cursor cursor = getContext().getContentResolver().query(Telephony.Sms.CONTENT_URI, columns, where, args, Telephony.Sms.DATE + " DESC")) {
            while (cursor != null && cursor.moveToNext() && items.length() < limit) {
                String address = cursor.getString(0);
                JSObject item = new JSObject();
                item.put("address", address);
                if (address != null && !names.containsKey(address)) names.put(address, contactName(address));
                String name = address != null ? names.get(address) : null;
                if (name != null) item.put("name", name);
                item.put("text", cursor.getString(1));
                item.put("time", cursor.getLong(2));
                item.put("sent", cursor.getInt(3) == Telephony.Sms.MESSAGE_TYPE_SENT);
                item.put("read", cursor.getInt(4) == 1);
                items.put(item);
            }
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    private String contactName(String number) {
        if (number == null || number.isEmpty()) return null;
        ContentResolver resolver = getContext().getContentResolver();
        Uri lookup = Uri.withAppendedPath(PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cursor = resolver.query(lookup, new String[] { PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : null;
        } catch (SecurityException | IllegalArgumentException error) {
            return null;
        }
    }
}
