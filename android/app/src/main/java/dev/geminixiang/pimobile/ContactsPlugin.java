package dev.geminixiang.pimobile;

import android.Manifest;
import android.content.ContentResolver;
import android.database.Cursor;
import android.provider.ContactsContract.CommonDataKinds.Email;
import android.provider.ContactsContract.CommonDataKinds.Event;
import android.provider.ContactsContract.CommonDataKinds.Organization;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import android.provider.ContactsContract.Data;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.LinkedHashMap;
import java.util.Map;

@CapacitorPlugin(name = "Contacts", permissions = { @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = "contacts") })
public class ContactsPlugin extends Plugin {

    private boolean ensurePermission(PluginCall call, String callback) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) return true;
        if (!TriggersPlugin.inFront(getActivity())) {
            call.reject("pi has no contacts permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.");
            return false;
        }
        requestPermissionForAlias("contacts", call, callback);
        return false;
    }

    @PluginMethod
    public void search(PluginCall call) {
        if (ensurePermission(call, "searchResult")) run(call);
    }

    @PermissionCallback
    private void searchResult(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) run(call);
        else call.reject("contacts permission denied", "permission");
    }

    private void run(PluginCall call) {
        String query = call.getString("query", "").trim();
        ContentResolver resolver = getContext().getContentResolver();
        String where = Data.MIMETYPE + " IN (?,?,?,?,?)";
        String[] kinds = { StructuredName.CONTENT_ITEM_TYPE, Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, Event.CONTENT_ITEM_TYPE, Organization.CONTENT_ITEM_TYPE };
        java.util.Set<Long> matched = null;
        if (!query.isEmpty()) {
            matched = new java.util.HashSet<>();
            String like = "%" + query + "%";
            String digits = query.replaceAll("[^0-9+]", "");
            String match = Data.DISPLAY_NAME + " LIKE ? OR (" + Data.MIMETYPE + "=? AND " + Data.DATA1 + " LIKE ?) OR (" + Data.MIMETYPE + "=? AND " + Data.DATA1 + " LIKE ?)";
            String[] args = { like, Email.CONTENT_ITEM_TYPE, like, Organization.CONTENT_ITEM_TYPE, like };
            if (digits.length() >= 3) {
                match += " OR (" + Data.MIMETYPE + "=? AND " + Phone.NORMALIZED_NUMBER + " LIKE ?)";
                args = new String[] { like, Email.CONTENT_ITEM_TYPE, like, Organization.CONTENT_ITEM_TYPE, like, Phone.CONTENT_ITEM_TYPE, "%" + digits.replaceFirst("^0", "") + "%" };
            }
            try (Cursor cursor = resolver.query(Data.CONTENT_URI, new String[] { Data.CONTACT_ID }, match, args, null)) {
                while (cursor != null && cursor.moveToNext()) matched.add(cursor.getLong(0));
            }
            if (matched.isEmpty()) {
                resolveWith(call, new JSArray());
                return;
            }
        }
        Map<Long, JSObject> people = new LinkedHashMap<>();
        String[] columns = { Data.CONTACT_ID, Data.DISPLAY_NAME, Data.MIMETYPE, Data.DATA1, Data.DATA2, Data.DATA3, Data.STARRED };
        try (Cursor cursor = resolver.query(Data.CONTENT_URI, columns, where, kinds, Data.DISPLAY_NAME + " COLLATE LOCALIZED")) {
            while (cursor != null && cursor.moveToNext()) {
                long id = cursor.getLong(0);
                if (matched != null && !matched.contains(id)) continue;
                JSObject person = people.get(id);
                if (person == null) {
                    person = new JSObject();
                    person.put("name", cursor.getString(1));
                    if (cursor.getInt(6) == 1) person.put("starred", true);
                    person.put("phones", new JSArray());
                    person.put("emails", new JSArray());
                    people.put(id, person);
                }
                String kind = cursor.getString(2);
                String value = cursor.getString(3);
                if (value == null || value.isEmpty()) continue;
                if (Phone.CONTENT_ITEM_TYPE.equals(kind)) {
                    JSObject phone = new JSObject();
                    phone.put("number", value);
                    phone.put("type", Phone.getTypeLabel(getContext().getResources(), cursor.getInt(4), cursor.getString(5)).toString());
                    person.optJSONArray("phones").put(phone);
                } else if (Email.CONTENT_ITEM_TYPE.equals(kind)) {
                    person.optJSONArray("emails").put(value);
                } else if (Organization.CONTENT_ITEM_TYPE.equals(kind)) {
                    person.put("company", value);
                } else if (Event.CONTENT_ITEM_TYPE.equals(kind) && cursor.getInt(4) == Event.TYPE_BIRTHDAY) {
                    person.put("birthday", value);
                }
            }
        }
        JSArray items = new JSArray();
        for (JSObject person : people.values()) items.put(person);
        resolveWith(call, items);
    }

    private static void resolveWith(PluginCall call, JSArray items) {
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }
}
