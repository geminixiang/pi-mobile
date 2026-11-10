package dev.geminixiang.pimobile

import android.Manifest
import android.net.Uri
import android.provider.CallLog
import android.provider.ContactsContract.PhoneLookup
import android.provider.Telephony
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

@CapacitorPlugin(
    name = "Records",
    permissions = [
        Permission(strings = [Manifest.permission.READ_CALL_LOG], alias = "calls"),
        Permission(strings = [Manifest.permission.READ_SMS], alias = "sms"),
    ],
)
class RecordsPlugin : Plugin() {
    @PluginMethod
    fun calls(call: PluginCall) =
        Background.run(call) {
            val since = call.data.optLong("since", 0L)
            val limit = call.getInt("limit", 50) ?: 50
            val columns = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION)
            val items = JSArray()
            val names = HashMap<String, String?>()
            context.contentResolver.query(CallLog.Calls.CONTENT_URI, columns, "${CallLog.Calls.DATE} >= $since", null, "${CallLog.Calls.DATE} DESC")?.use { cursor ->
                while (cursor.moveToNext() && items.length() < limit) {
                    val number: String? = cursor.getString(0)
                    val cached: String? = cursor.getString(1)
                    val name =
                        if (cached.isNullOrEmpty() && number != null) {
                            if (number !in names) names[number] = contactName(number)
                            names[number]
                        } else {
                            cached
                        }
                    val item = JSObject().put("number", number.orEmpty())
                    if (name != null) item.put("name", name)
                    item.put("type", callType(cursor.getInt(2)))
                    item.put("time", cursor.getLong(3))
                    item.put("seconds", cursor.getLong(4))
                    items.put(item)
                }
            }
            call.resolve(JSObject().put("items", items))
        }

    @PluginMethod
    fun sms(call: PluginCall) =
        Background.run(call) {
            val since = call.data.optLong("since", 0L)
            val limit = call.getInt("limit", 50) ?: 50
            val query = call.getString("query", "").orEmpty()
            val matching = if (query.isEmpty()) "" else " AND (${Telephony.Sms.BODY} LIKE ? OR ${Telephony.Sms.ADDRESS} LIKE ?)"
            val where = "${Telephony.Sms.DATE} >= $since$matching"
            val args = if (query.isEmpty()) null else arrayOf("%$query%", "%$query%")
            val columns = arrayOf(Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ)
            val names = HashMap<String, String?>()
            val items = JSArray()
            context.contentResolver.query(Telephony.Sms.CONTENT_URI, columns, where, args, "${Telephony.Sms.DATE} DESC")?.use { cursor ->
                while (cursor.moveToNext() && items.length() < limit) {
                    val address: String? = cursor.getString(0)
                    val item = JSObject().put("address", address.orEmpty())
                    if (address != null && address !in names) names[address] = contactName(address)
                    val name = address?.let { names[it] }
                    if (name != null) item.put("name", name)
                    item.put("text", cursor.getString(1).orEmpty())
                    item.put("time", cursor.getLong(2))
                    item.put("sent", cursor.getInt(3) == Telephony.Sms.MESSAGE_TYPE_SENT)
                    item.put("read", cursor.getInt(4) == 1)
                    items.put(item)
                }
            }
            call.resolve(JSObject().put("items", items))
        }

    private fun contactName(number: String): String? {
        if (number.isEmpty()) return null
        val lookup = Uri.withAppendedPath(PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        return try {
            context.contentResolver.query(lookup, arrayOf(PhoneLookup.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        } catch (error: SecurityException) {
            null
        } catch (error: IllegalArgumentException) {
            null
        }
    }

    companion object {
        private fun callType(type: Int): String =
            when (type) {
                CallLog.Calls.INCOMING_TYPE -> "incoming"
                CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                CallLog.Calls.MISSED_TYPE -> "missed"
                CallLog.Calls.REJECTED_TYPE -> "rejected"
                CallLog.Calls.BLOCKED_TYPE -> "blocked"
                CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
                else -> "other"
            }
    }
}
