import Capacitor
import Contacts
import UIKit

@objc(ContactsPlugin)
public class ContactsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ContactsPlugin"
    public let jsName = "Contacts"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "search", returnType: CAPPluginReturnPromise)]

    private let store = CNContactStore()
    private let keys: [CNKeyDescriptor] = [
        CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        CNContactOrganizationNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
        CNContactEmailAddressesKey as CNKeyDescriptor,
        CNContactBirthdayKey as CNKeyDescriptor,
    ]

    private func withAccess(_ call: CAPPluginCall, _ then: @escaping () -> Void) {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if status == .authorized || status == .limited {
            DispatchQueue.global(qos: .userInitiated).async(execute: then)
            return
        }
        guard status == .notDetermined else {
            call.reject("contacts permission denied: the user can allow it in Settings › pi mobile › Contacts", "permission")
            return
        }
        DispatchQueue.main.async {
            guard UIApplication.shared.applicationState != .background else {
                call.reject("pi has no contacts permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
                return
            }
            self.store.requestAccess(for: .contacts) { granted, _ in
                if granted { DispatchQueue.global(qos: .userInitiated).async(execute: then) } else { call.reject("contacts permission denied", "permission") }
            }
        }
    }

    private static func birthday(_ parts: DateComponents?) -> String? {
        guard let parts, let month = parts.month, let day = parts.day else { return nil }
        let monthDay = String(format: "%02d-%02d", month, day)
        guard let year = parts.year, year != NSDateComponentUndefined else { return "--\(monthDay)" }
        return String(format: "%04d-", year) + monthDay
    }

    @objc func search(_ call: CAPPluginCall) {
        let query = (call.getString("query") ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let digits = query.filter { $0.isNumber || $0 == "+" }
        withAccess(call) {
            var items: [[String: Any]] = []
            let request = CNContactFetchRequest(keysToFetch: self.keys)
            request.sortOrder = .userDefault
            do {
                try self.store.enumerateContacts(with: request) { contact, _ in
                    let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
                    let phones = contact.phoneNumbers.map { labeled -> [String: Any] in
                        ["number": labeled.value.stringValue, "type": labeled.label.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) } ?? "電話"]
                    }
                    let emails = contact.emailAddresses.map { $0.value as String }
                    if !query.isEmpty {
                        let text = ([name, contact.organizationName] + emails).joined(separator: " ").lowercased()
                        let numbers = contact.phoneNumbers.map { $0.value.stringValue.filter { $0.isNumber || $0 == "+" } }
                        guard text.contains(query) || (digits.count >= 3 && numbers.contains { $0.contains(digits) }) else { return }
                    }
                    var person: [String: Any] = ["name": name, "phones": phones, "emails": emails]
                    if !contact.organizationName.isEmpty { person["company"] = contact.organizationName }
                    if let birthday = Self.birthday(contact.birthday) { person["birthday"] = birthday }
                    items.append(person)
                }
                call.resolve(["items": items])
            } catch {
                call.reject("could not read contacts: \(error.localizedDescription)")
            }
        }
    }
}
