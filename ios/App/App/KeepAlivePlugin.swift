import BackgroundTasks
import Capacitor
import UserNotifications

@objc(KeepAlivePlugin)
public class KeepAlivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "KeepAlivePlugin"
    public let jsName = "KeepAlive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestUnrestrictedBattery", returnType: CAPPluginReturnPromise),
    ]

    private var task: BGContinuedProcessingTask?
    private var pending = false
    private var ticker: Timer?

    @objc func start(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? "pi 工作中"
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            if let running = self.task {
                running.updateTitle(title, subtitle: text)
                call.resolve()
                return
            }
            if self.pending {
                call.resolve()
                return
            }
            let id = "\(Bundle.main.bundleIdentifier ?? "dev.geminixiang.pimobile").turn.\(UUID().uuidString)"
            BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: .main) { raw in
                guard let task = raw as? BGContinuedProcessingTask else { return }
                self.run(task)
            }
            let request = BGContinuedProcessingTaskRequest(identifier: id, title: title, subtitle: text)
            request.strategy = .fail
            do {
                try BGTaskScheduler.shared.submit(request)
                self.pending = true
                call.resolve()
            } catch {
                call.reject("could not start background work: \(error.localizedDescription)")
            }
        }
    }

    private func run(_ task: BGContinuedProcessingTask) {
        pending = false
        self.task = task
        task.progress.totalUnitCount = 1000
        task.expirationHandler = { [weak self] in
            DispatchQueue.main.async { self?.finish(success: false) }
        }
        // why: the system expires a continued task that reports no progress; a turn has no measurable total, so the bar creeps while it runs
        ticker = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            task.progress.completedUnitCount = min(task.progress.completedUnitCount + 1, 999)
        }
    }

    private func finish(success: Bool) {
        ticker?.invalidate()
        ticker = nil
        if let running = task {
            running.progress.completedUnitCount = running.progress.totalUnitCount
            running.setTaskCompleted(success: success)
        }
        task = nil
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finish(success: true)
            call.resolve()
        }
    }

    @objc func notify(_ call: CAPPluginCall) {
        let content = UNMutableNotificationContent()
        content.title = call.getString("title") ?? "pi"
        content.body = call.getString("text") ?? ""
        let request = UNNotificationRequest(identifier: "pi.done", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { call.reject(error.localizedDescription) } else { call.resolve() }
        }
    }

    @objc func clearNotification(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["pi.done"])
        call.resolve()
    }

    @objc func status(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(["notifications": settings.authorizationStatus == .authorized])
        }
    }

    @objc func requestNotifications(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            call.resolve(["granted": granted])
        }
    }

    @objc func requestUnrestrictedBattery(_ call: CAPPluginCall) {
        call.resolve()
    }
}
