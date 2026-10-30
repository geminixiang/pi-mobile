import Capacitor
import CoreMotion

// why: CMPedometer keeps only the last 7 days of steps; older dates come back as an error
private let pedometerDays = 7

@objc(HealthPlugin)
public class HealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HealthPlugin"
    public let jsName = "Health"
    public let pluginMethods: [CAPPluginMethod] = ["read"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private let pedometer = CMPedometer()

    @objc func read(_ call: CAPPluginCall) {
        guard call.getString("metric") == "steps" else {
            call.reject("on iPhone pi reads only steps, counted by the phone itself; heart rate, sleep, exercise, and weight are in Apple Health, which pi cannot read", "unsupported")
            return
        }
        guard CMPedometer.isStepCountingAvailable() else {
            call.reject("this iPhone cannot count steps", "unavailable")
            return
        }
        if [.denied, .restricted].contains(CMPedometer.authorizationStatus()) {
            call.reject("pi may not read motion: the user can allow 動作與健身 in Settings › Pi", "permission")
            return
        }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let count = min(max(call.getInt("days") ?? pedometerDays, 1), pedometerDays)
        let starts = (0..<count).reversed().compactMap { calendar.date(byAdding: .day, value: -$0, to: today) }
        Task {
            do {
                var days: [[String: Any]] = []
                for start in starts {
                    let end = min(calendar.date(byAdding: .day, value: 1, to: start) ?? Date(), Date())
                    let parts = calendar.dateComponents([.year, .month, .day], from: start)
                    let day = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
                    days.append(["day": day, "value": try await steps(from: start, to: end)])
                }
                call.resolve(["days": days])
            } catch {
                call.reject("could not read steps: \(error.localizedDescription)")
            }
        }
    }

    private func steps(from start: Date, to end: Date) async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            pedometer.queryPedometerData(from: start, to: end) { data, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: data?.numberOfSteps.intValue ?? 0)
                }
            }
        }
    }
}
