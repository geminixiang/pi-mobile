package dev.geminixiang.pimobile

import android.Manifest
import android.provider.ContactsContract.CommonDataKinds.Email
import android.provider.ContactsContract.CommonDataKinds.Event
import android.provider.ContactsContract.CommonDataKinds.Organization
import android.provider.ContactsContract.CommonDataKinds.Phone
import android.provider.ContactsContract.CommonDataKinds.StructuredName
import android.provider.ContactsContract.Data
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

@CapacitorPlugin(name = "Contacts", permissions = [Permission(strings = [Manifest.permission.READ_CONTACTS], alias = "contacts")])
class ContactsPlugin : Plugin() {
    @PluginMethod
    fun search(call: PluginCall) =
        Background.run(call) {
            val query = call.getString("query", "").orEmpty().trim()
            val resolver = context.contentResolver
            val where = Data.MIMETYPE + " IN (?,?,?,?,?)"
            val kinds = arrayOf(StructuredName.CONTENT_ITEM_TYPE, Phone.CONTENT_ITEM_TYPE, Email.CONTENT_ITEM_TYPE, Event.CONTENT_ITEM_TYPE, Organization.CONTENT_ITEM_TYPE)
            val matched =
                if (query.isEmpty()) {
                    null
                } else {
                    val like = "%$query%"
                    val digits = query.filter { it in '0'..'9' || it == '+' }
                    val textMatch =
                        Data.DISPLAY_NAME + " LIKE ? OR (" + Data.MIMETYPE + "=? AND " + Data.DATA1 + " LIKE ?) OR (" + Data.MIMETYPE + "=? AND " + Data.DATA1 + " LIKE ?)"
                    val textArgs = arrayOf(like, Email.CONTENT_ITEM_TYPE, like, Organization.CONTENT_ITEM_TYPE, like)
                    val byPhone = digits.length >= 3
                    val match = if (byPhone) textMatch + " OR (" + Data.MIMETYPE + "=? AND " + Phone.NORMALIZED_NUMBER + " LIKE ?)" else textMatch
                    val args = if (byPhone) textArgs + arrayOf(Phone.CONTENT_ITEM_TYPE, "%" + digits.removePrefix("0") + "%") else textArgs
                    val ids =
                        resolver.query(Data.CONTENT_URI, arrayOf(Data.CONTACT_ID), match, args, null)?.use { cursor ->
                            buildSet { while (cursor.moveToNext()) add(cursor.getLong(0)) }
                        }.orEmpty()
                    if (ids.isEmpty()) {
                        resolveWith(call, JSArray())
                        return@run
                    }
                    ids
                }
            val people = LinkedHashMap<Long, JSObject>()
            val columns = arrayOf(Data.CONTACT_ID, Data.DISPLAY_NAME, Data.MIMETYPE, Data.DATA1, Data.DATA2, Data.DATA3, Data.STARRED)
            resolver.query(Data.CONTENT_URI, columns, where, kinds, Data.DISPLAY_NAME + " COLLATE LOCALIZED")?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0)
                    if (matched != null && id !in matched) continue
                    val person =
                        people.getOrPut(id) {
                            JSObject().apply {
                                put("name", cursor.getString(1).orEmpty())
                                if (cursor.getInt(6) == 1) put("starred", true)
                                put("phones", JSArray())
                                put("emails", JSArray())
                            }
                        }
                    val kind = cursor.getString(2)
                    val value = cursor.getString(3)
                    if (value.isNullOrEmpty()) continue
                    when {
                        kind == Phone.CONTENT_ITEM_TYPE -> {
                            val phone = JSObject()
                            phone.put("number", value)
                            phone.put("type", Phone.getTypeLabel(context.resources, cursor.getInt(4), cursor.getString(5)).toString())
                            person.optJSONArray("phones")?.put(phone)
                        }
                        kind == Email.CONTENT_ITEM_TYPE -> person.optJSONArray("emails")?.put(value)
                        kind == Organization.CONTENT_ITEM_TYPE -> person.put("company", value)
                        kind == Event.CONTENT_ITEM_TYPE && cursor.getInt(4) == Event.TYPE_BIRTHDAY -> person.put("birthday", value)
                    }
                }
            }
            val items = JSArray()
            people.values.forEach { items.put(it) }
            resolveWith(call, items)
        }

    companion object {
        private fun resolveWith(call: PluginCall, items: JSArray) {
            call.resolve(JSObject().put("items", items))
        }
    }
}
