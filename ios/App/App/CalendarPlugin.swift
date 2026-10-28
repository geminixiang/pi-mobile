import Capacitor
import EventKit
import UIKit

private let day: TimeInterval = 86_400

@objc(CalendarPlugin)
public class CalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CalendarPlugin"
    public let jsName = "Calendar"
    public let pluginMethods: [CAPPluginMethod] = ["listAccounts", "listEvents", "insertEvent", "deleteEvent", "checkPermissions"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private let store = EKEventStore()
    private let idsKey = "pi.calendarIds"

    // why: the JS interface (and the default calendar in settings) uses Android's numeric calendar ids; EventKit's are strings, so each gets a number once and keeps it
    private func number(of calendar: EKCalendar) -> Int {
        var ids = UserDefaults.standard.dictionary(forKey: idsKey) as? [String: Int] ?? [:]
        if let id = ids[calendar.calendarIdentifier] { return id }
        let id = (ids.values.max() ?? 0) + 1
        ids[calendar.calendarIdentifier] = id
        UserDefaults.standard.set(ids, forKey: idsKey)
        return id
    }

    private func calendar(numbered id: Int) -> EKCalendar? {
        let ids = UserDefaults.standard.dictionary(forKey: idsKey) as? [String: Int] ?? [:]
        guard let identifier = ids.first(where: { $0.value == id })?.key else { return nil }
        return store.calendar(withIdentifier: identifier)
    }

    private func own(_ calendar: EKCalendar) -> Bool {
        calendar.type != .subscription && calendar.type != .birthday
    }

    private func writable(_ calendar: EKCalendar) -> Bool {
        own(calendar) && calendar.allowsContentModifications
    }

    private func accountType(_ calendar: EKCalendar) -> String {
        switch calendar.source?.sourceType {
        case .local: return "LOCAL"
        case .exchange: return "Exchange"
        case .calDAV: return "CalDAV"
        case .subscribed: return "訂閱"
        case .birthdays: return "生日"
        default: return "其他"
        }
    }

    private var granted: Bool {
        EKEventStore.authorizationStatus(for: .event) == .fullAccess
    }

    private func withAccess(_ call: CAPPluginCall, _ then: @escaping () -> Void) {
        if granted {
            then()
            return
        }
        switch EKEventStore.authorizationStatus(for: .event) {
        case .notDetermined:
            DispatchQueue.main.async {
                guard UIApplication.shared.applicationState != .background else {
                    call.reject("pi has no calendar permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
                    return
                }
                self.store.requestFullAccessToEvents { granted, _ in
                    if granted { then() } else { call.reject("calendar permission denied", "permission") }
                }
            }
        default:
            call.reject("calendar permission denied: the user can allow full access in Settings › Pi › Calendars", "permission")
        }
    }

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let undecided = EKEventStore.authorizationStatus(for: .event) == .notDetermined
        call.resolve(["calendar": granted ? "granted" : undecided ? "prompt" : "denied"])
    }

    @objc func listAccounts(_ call: CAPPluginCall) {
        withAccess(call) {
            let primary = self.store.defaultCalendarForNewEvents?.calendarIdentifier
            let calendars = self.store.calendars(for: .event).map { calendar -> [String: Any] in
                let own = self.own(calendar)
                let account = calendar.source?.title ?? ""
                return [
                    "id": self.number(of: calendar),
                    "name": calendar.title,
                    "account": account,
                    "accountType": self.accountType(calendar),
                    "owner": account,
                    "own": own,
                    "writable": self.writable(calendar),
                    "primary": calendar.calendarIdentifier == primary,
                ]
            }
            call.resolve(["calendars": calendars])
        }
    }

    // why: Android reports an all-day event from UTC midnight of its first day to UTC midnight after its last, and the JS side reads it that way
    private func utcMidnight(ofLocal date: Date) -> Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return utc.date(from: parts) ?? date
    }

    private func localMidnight(ofUtc date: Date) -> Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC") ?? .current
        let parts = utc.dateComponents([.year, .month, .day], from: date)
        return Calendar.current.date(from: parts) ?? date
    }

    private func millis(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private func listedBegin(of event: EKEvent) -> Date? {
        guard let start = event.startDate else { return nil }
        return event.isAllDay ? utcMidnight(ofLocal: start) : start
    }

    @objc func listEvents(_ call: CAPPluginCall) {
        guard let from = (call.options["from"] as? NSNumber)?.doubleValue, let to = (call.options["to"] as? NSNumber)?.doubleValue, to > from else {
            call.reject("from and to are required, with to after from")
            return
        }
        let includeShared = call.getBool("includeShared") ?? false
        withAccess(call) {
            let range = self.store.predicateForEvents(withStart: Date(timeIntervalSince1970: from / 1000), end: Date(timeIntervalSince1970: to / 1000), calendars: nil)
            let events = self.store.events(matching: range).compactMap { event -> [String: Any]? in
                guard let calendar = event.calendar, let begin = self.listedBegin(of: event), let finish = event.endDate, event.status != .canceled else { return nil }
                if event.attendees?.contains(where: { $0.isCurrentUser && $0.participantStatus == .declined }) == true { return nil }
                let own = self.own(calendar)
                if !own && !includeShared { return nil }
                let end = event.isAllDay ? self.utcMidnight(ofLocal: finish).addingTimeInterval(day) : finish
                var out: [String: Any] = [
                    "id": event.eventIdentifier ?? "",
                    "title": event.title ?? "",
                    "begin": self.millis(begin),
                    "end": self.millis(end),
                    "allDay": event.isAllDay,
                    "calendar": calendar.title,
                    "account": calendar.source?.title ?? "",
                    "accountType": self.accountType(calendar),
                    "calendarId": self.number(of: calendar),
                ]
                if let location = event.location, !location.isEmpty { out["location"] = location }
                if let notes = event.notes, !notes.isEmpty { out["notes"] = notes.count > 400 ? String(notes.prefix(400)) + "…" : notes }
                if !own {
                    out["shared"] = true
                    out["owner"] = calendar.source?.title ?? ""
                }
                return out
            }
            call.resolve(["events": events])
        }
    }

    @objc func insertEvent(_ call: CAPPluginCall) {
        guard let id = call.getInt("calendarId"), let begin = (call.options["begin"] as? NSNumber)?.doubleValue, let end = (call.options["end"] as? NSNumber)?.doubleValue else {
            call.reject("calendarId, begin and end are required")
            return
        }
        withAccess(call) {
            guard let calendar = self.calendar(numbered: id), self.writable(calendar) else {
                call.reject("calendar \(id) is not one of the user's own writable calendars", "not_allowed")
                return
            }
            let allDay = call.getBool("allDay") ?? false
            let event = EKEvent(eventStore: self.store)
            event.calendar = calendar
            event.title = call.getString("title") ?? ""
            event.isAllDay = allDay
            let start = Date(timeIntervalSince1970: begin / 1000)
            let finish = Date(timeIntervalSince1970: end / 1000)
            event.startDate = allDay ? self.localMidnight(ofUtc: start) : start
            event.endDate = allDay ? self.localMidnight(ofUtc: finish.addingTimeInterval(-day)) : finish
            event.location = call.getString("location")
            event.notes = call.getString("description")
            do {
                try self.store.save(event, span: .thisEvent, commit: true)
                call.resolve(["id": event.eventIdentifier ?? ""])
            } catch {
                call.reject("could not save the event: \(error.localizedDescription)")
            }
        }
    }

    @objc func deleteEvent(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let begin = (call.options["begin"] as? NSNumber)?.doubleValue else {
            call.reject("id and begin are required")
            return
        }
        let all = call.getBool("all") ?? false
        withAccess(call) {
            let at = Date(timeIntervalSince1970: begin / 1000)
            let around = self.store.predicateForEvents(withStart: at.addingTimeInterval(-day), end: at.addingTimeInterval(day), calendars: nil)
            let wanted = self.millis(at)
            guard let occurrence = self.store.events(matching: around).first(where: { event in
                event.eventIdentifier == id && self.listedBegin(of: event).map(self.millis) == wanted
            }) else {
                call.reject("no event \(id) begins at \(wanted)", "not_found")
                return
            }
            guard let calendar = occurrence.calendar, self.writable(calendar) else {
                call.reject("event \(id) is not in one of the user's own writable calendars", "not_allowed")
                return
            }
            let repeating = occurrence.hasRecurrenceRules || occurrence.isDetached
            let seriesId = occurrence.isDetached ? id.components(separatedBy: "/RID=")[0] : id
            guard let target = all ? self.store.event(withIdentifier: seriesId) : occurrence, target.calendar?.calendarIdentifier == calendar.calendarIdentifier else {
                call.reject("could not find the series event \(id) belongs to", "not_found")
                return
            }
            do {
                try self.store.remove(target, span: all ? .futureEvents : .thisEvent, commit: true)
                call.resolve(["repeating": repeating])
            } catch {
                call.reject("could not delete the event: \(error.localizedDescription)")
            }
        }
    }
}
