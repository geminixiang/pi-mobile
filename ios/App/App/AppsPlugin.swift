import AlarmKit
import Capacitor
import MessageUI
import QuickLook
import SwiftUI
import UIKit

private struct PiAlarm: AlarmMetadata {}

@objc(AppsPlugin)
public class AppsPlugin: CAPPlugin, CAPBridgedPlugin, MFMailComposeViewControllerDelegate, MFMessageComposeViewControllerDelegate, QLPreviewControllerDataSource {
    public let identifier = "AppsPlugin"
    public let jsName = "Apps"
    public let pluginMethods: [CAPPluginMethod] = ["setAlarm", "setTimer", "composeEmail", "composeSms", "open", "share", "openFile"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private var previewing: URL?

    private func present(_ call: CAPPluginCall, _ controller: UIViewController) {
        guard let presenter = bridge?.viewController else {
            call.reject("no window to open it in")
            return
        }
        controller.popoverPresentationController?.sourceView = presenter.view
        controller.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY, width: 0, height: 0)
        presenter.present(controller, animated: true)
        call.resolve()
    }

    // why: the first call waits on the permission alert, which can stay up for minutes; a timer's end is counted from when it is allowed, or it lands in the past and AlarmKit refuses it
    private func schedule(_ call: CAPPluginCall, label: String, _ alarm: @escaping () -> Alarm.Schedule) {
        Task {
            do {
                let state = try await AlarmManager.shared.requestAuthorization()
                guard state == .authorized else {
                    call.reject("alarms are not allowed: the user can allow them in Settings › pi mobile › Alarms & Timers", "permission")
                    return
                }
                let stop = AlarmButton(text: "停止", textColor: .white, systemImageName: "stop.circle")
                let presentation = AlarmPresentation(alert: AlarmPresentation.Alert(title: "\(label)", stopButton: stop))
                let attributes = AlarmAttributes<PiAlarm>(presentation: presentation, tintColor: .orange)
                _ = try await AlarmManager.shared.schedule(id: UUID(), configuration: .alarm(schedule: alarm(), attributes: attributes))
                call.resolve()
            } catch {
                call.reject("could not set the alarm: \(error.localizedDescription)")
            }
        }
    }

    @objc func setAlarm(_ call: CAPPluginCall) {
        guard let hour = call.getInt("hour"), let minute = call.getInt("minute") else {
            call.reject("hour and minute are required")
            return
        }
        let weekdays: [Locale.Weekday] = [.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
        let days = (call.getArray("days", Int.self) ?? []).compactMap { $0 >= 1 && $0 <= 7 ? weekdays[$0 - 1] : nil }
        let time = Alarm.Schedule.Relative.Time(hour: hour, minute: minute)
        schedule(call, label: call.getString("label") ?? "鬧鐘") { .relative(.init(time: time, repeats: days.isEmpty ? .never : .weekly(days))) }
    }

    // why: AlarmKit's countdown timer needs a widget extension for its Live Activity; a timer here is an alarm at the moment it ends
    @objc func setTimer(_ call: CAPPluginCall) {
        guard let seconds = call.getInt("seconds"), seconds > 0 else {
            call.reject("seconds is required")
            return
        }
        schedule(call, label: call.getString("label") ?? "計時器") { .fixed(Date().addingTimeInterval(TimeInterval(seconds))) }
    }

    private func openUrl(_ call: CAPPluginCall, _ url: URL) {
        Task { @MainActor in
            guard await UIApplication.shared.open(url) else {
                call.reject("no app opens \(url.scheme ?? "this"): links")
                return
            }
            call.resolve()
        }
    }

    @objc func composeEmail(_ call: CAPPluginCall) {
        let to = call.getArray("to", String.self) ?? []
        let subject = call.getString("subject") ?? ""
        let body = call.getString("body") ?? ""
        DispatchQueue.main.async {
            guard MFMailComposeViewController.canSendMail() else {
                var parts = URLComponents()
                parts.scheme = "mailto"
                parts.path = to.joined(separator: ",")
                parts.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: body)]
                guard let url = parts.url else {
                    call.reject("could not build the email")
                    return
                }
                self.openUrl(call, url)
                return
            }
            let mail = MFMailComposeViewController()
            mail.mailComposeDelegate = self
            mail.setToRecipients(to)
            mail.setSubject(subject)
            mail.setMessageBody(body, isHTML: false)
            self.present(call, mail)
        }
    }

    @objc func composeSms(_ call: CAPPluginCall) {
        let to = call.getString("to") ?? ""
        let body = call.getString("body") ?? ""
        DispatchQueue.main.async {
            guard MFMessageComposeViewController.canSendText() else {
                var parts = URLComponents()
                parts.scheme = "sms"
                parts.path = to
                parts.queryItems = [URLQueryItem(name: "body", value: body)]
                guard let url = parts.url else {
                    call.reject("could not build the message")
                    return
                }
                self.openUrl(call, url)
                return
            }
            let message = MFMessageComposeViewController()
            message.messageComposeDelegate = self
            if !to.isEmpty { message.recipients = [to] }
            message.body = body
            self.present(call, message)
        }
    }

    public func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
        controller.dismiss(animated: true)
    }

    public func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        controller.dismiss(animated: true)
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let url = URL(string: call.getString("uri") ?? ""), url.scheme != nil else {
            call.reject("not a link")
            return
        }
        openUrl(call, url)
    }

    private func file(_ call: CAPPluginCall) throws -> URL? {
        guard let data = call.getString("fileBase64").flatMap({ Data(base64Encoded: $0) }) else { return nil }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = (call.getString("fileName") ?? "file").replacingOccurrences(of: "/", with: "_")
        let url = folder.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    @objc func share(_ call: CAPPluginCall) {
        do {
            var items: [Any] = []
            if let text = call.getString("text"), !text.isEmpty { items.append(text) }
            if let url = try file(call) { items.append(url) }
            guard !items.isEmpty else {
                call.reject("give text, a file, or both")
                return
            }
            DispatchQueue.main.async { self.present(call, UIActivityViewController(activityItems: items, applicationActivities: nil)) }
        } catch {
            call.reject("could not prepare the file: \(error.localizedDescription)")
        }
    }

    @objc func openFile(_ call: CAPPluginCall) {
        do {
            guard let url = try file(call) else {
                call.reject("fileBase64 is required")
                return
            }
            DispatchQueue.main.async {
                self.previewing = url
                let preview = QLPreviewController()
                preview.dataSource = self
                self.present(call, preview)
            }
        } catch {
            call.reject("could not prepare the file: \(error.localizedDescription)")
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
        previewing == nil ? 0 : 1
    }

    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
        (previewing ?? URL(fileURLWithPath: "/")) as NSURL
    }
}
