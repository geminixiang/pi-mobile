import AVFoundation
import Capacitor
import CoreLocation
import CoreMotion
import MapKit
import Network
import UIKit

private let fixTimeout: TimeInterval = 20

@objc(PhonePlugin)
public class PhonePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "PhonePlugin"
    public let jsName = "Phone"
    public let pluginMethods: [CAPPluginMethod] = ["getStatus", "getLocation", "readSensors", "geocode"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private lazy var locations: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        return manager
    }()
    private var headings: [(CLHeading) -> Void] = []
    private let altimeter = CMAltimeter()
    private let motion = CMMotionManager()

    @objc func getLocation(_ call: CAPPluginCall) {
        Task { @MainActor in
            if self.locations.authorizationStatus == .notDetermined, UIApplication.shared.applicationState == .background {
                call.reject("pi has no location permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
                return
            }
            guard CLLocationManager.locationServicesEnabled() else {
                call.reject("location is turned off on the phone", "disabled")
                return
            }
            let session = CLServiceSession(authorization: .whenInUse)
            defer { session.invalidate() }
            let fix = await withTaskGroup(of: Result<CLLocation, LocationFailure>?.self) { group in
                group.addTask { await Self.firstFix() }
                group.addTask {
                    try? await Task.sleep(for: .seconds(fixTimeout))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
            switch fix {
            case let .success(location):
                await self.answer(call, location, lastKnown: false)
            case let .failure(failure):
                call.reject(failure.message, failure.code)
            case nil:
                if let last = self.locations.location {
                    await self.answer(call, last, lastKnown: true)
                } else {
                    call.reject("no location fix within \(Int(fixTimeout)) seconds", "timeout")
                }
            }
        }
    }

    private struct LocationFailure: Error {
        let message: String
        let code: String
    }

    private static func firstFix() async -> Result<CLLocation, LocationFailure>? {
        do {
            for try await update in CLLocationUpdate.liveUpdates() {
                if update.authorizationDenied || update.authorizationDeniedGlobally || update.authorizationRestricted {
                    return .failure(LocationFailure(message: "location permission denied: the user can allow it in Settings › Pi › Location", code: "permission"))
                }
                if let location = update.location { return .success(location) }
            }
        } catch {
            return .failure(LocationFailure(message: "location failed: \(error.localizedDescription)", code: "failed"))
        }
        return nil
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        let waiting = headings
        headings = []
        manager.stopUpdatingHeading()
        for answer in waiting { answer(heading) }
    }

    private func answer(_ call: CAPPluginCall, _ location: CLLocation, lastKnown: Bool) async {
        var result: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyMeters": Int(location.horizontalAccuracy.rounded()),
            "ageSeconds": max(0, Int(-location.timestamp.timeIntervalSinceNow)),
            "provider": "core-location",
            "approximate": locations.accuracyAuthorization == .reducedAccuracy,
            "lastKnown": lastKnown,
        ]
        if location.verticalAccuracy >= 0 { result["altitudeMeters"] = Int(location.altitude.rounded()) }
        if location.speed >= 0 { result["speedMetersPerSecond"] = (location.speed * 10).rounded() / 10 }
        if location.course >= 0 { result["bearingDegrees"] = Int(location.course.rounded()) }
        if let request = MKReverseGeocodingRequest(location: location), let item = try? await request.mapItems.first {
            result["address"] = Self.address(item)
        }
        call.resolve(result)
    }

    private static func address(_ item: MKMapItem) -> [String: Any] {
        var address: [String: Any] = [:]
        if let line = item.address?.shortAddress ?? item.address?.fullAddress { address["line"] = line }
        if let parts = item.addressRepresentations {
            if let country = parts.regionName { address["country"] = country }
            if let city = parts.cityName { address["locality"] = city }
        }
        return address
    }

    @objc func geocode(_ call: CAPPluginCall) {
        let query = (call.getString("query") ?? "").trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            call.reject("query is empty")
            return
        }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = query
        request.resultTypes = [.pointOfInterest, .address]
        MKLocalSearch(request: request).start { response, error in
            guard let item = response?.mapItems.first else {
                let none = (error as? MKError)?.code == .placemarkNotFound || error == nil
                call.reject(none ? "no place found for \(query)" : "geocoding failed: \(error?.localizedDescription ?? "")", none ? "not_found" : "failed")
                return
            }
            var result: [String: Any] = ["latitude": item.location.coordinate.latitude, "longitude": item.location.coordinate.longitude]
            let label = [item.name, Self.address(item)["line"] as? String].compactMap { $0 }.filter { !$0.isEmpty }
            if !label.isEmpty { result["address"] = label.joined(separator: "，") }
            call.resolve(result)
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            var battery: [String: Any] = ["powerSaving": ProcessInfo.processInfo.isLowPowerModeEnabled]
            if device.batteryLevel >= 0 { battery["percent"] = Int((device.batteryLevel * 100).rounded()) }
            battery["charging"] = device.batteryState == .charging || device.batteryState == .full
            let outputs = AVAudioSession.sharedInstance().currentRoute.outputs.compactMap { output -> [String: Any]? in
                switch output.portType {
                case .headphones, .usbAudio: return ["kind": "wired", "name": output.portName]
                case .bluetoothA2DP, .bluetoothLE, .bluetoothHFP: return ["kind": "bluetooth", "name": output.portName]
                default: return nil
                }
            }
            var system = utsname()
            uname(&system)
            let machine = withUnsafeBytes(of: system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
            var result: [String: Any] = [
                "battery": battery,
                "sound": ["connectedAudio": outputs],
                "model": "Apple \(device.model) (\(machine))",
                "ios": device.systemVersion,
            ]
            if let free = try? URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]) {
                var storage: [String: Any] = [:]
                if let bytes = free.volumeAvailableCapacityForImportantUsage { storage["freeGB"] = (Double(bytes) / 1e8).rounded() / 10 }
                if let bytes = free.volumeTotalCapacity { storage["totalGB"] = (Double(bytes) / 1e8).rounded() / 10 }
                result["storage"] = storage
            }
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                monitor.cancel()
                let type = path.status != .satisfied ? "none" : path.usesInterfaceType(.wifi) ? "wifi" : path.usesInterfaceType(.cellular) ? "cellular" : path.usesInterfaceType(.wiredEthernet) ? "ethernet" : "other"
                result["network"] = ["type": type, "metered": path.isExpensive, "constrained": path.isConstrained, "internet": path.status == .satisfied]
                call.resolve(result)
            }
            monitor.start(queue: DispatchQueue(label: "pi.phone.network"))
        }
    }

    @objc func readSensors(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var result: [String: Any] = [:]
            var missing: [String] = ["light", "proximity"]
            var finished = false
            let group = DispatchGroup()
            if CMAltimeter.isRelativeAltitudeAvailable() {
                group.enter()
                var once = false
                self.altimeter.startRelativeAltitudeUpdates(to: .main) { data, _ in
                    guard !once, !finished else { return }
                    once = true
                    self.altimeter.stopRelativeAltitudeUpdates()
                    if let data {
                        let hPa = data.pressure.doubleValue * 10
                        let altitude = 44330 * (1 - pow(hPa / 1013.25, 1 / 5.255))
                        result["barometer"] = ["pressureHPa": (hPa * 10).rounded() / 10, "altitudeMetersEstimate": Int(altitude.rounded())]
                    } else {
                        missing.append("barometer")
                    }
                    group.leave()
                }
            } else {
                missing.append("barometer")
            }
            if CLLocationManager.headingAvailable() {
                group.enter()
                self.headings.append { heading in
                    let magnetic = heading.magneticHeading
                    var compass: [String: Any] = ["magneticHeadingDegrees": Int(magnetic.rounded())]
                    if heading.trueHeading >= 0 { compass["trueHeadingDegrees"] = Int(heading.trueHeading.rounded()) }
                    if let attitude = self.motion.deviceMotion?.attitude {
                        compass["pitchDegrees"] = Int((attitude.pitch * 180 / .pi).rounded())
                        compass["rollDegrees"] = Int((attitude.roll * 180 / .pi).rounded())
                    }
                    let points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
                    let facing = heading.trueHeading >= 0 ? heading.trueHeading : magnetic
                    compass["facing"] = points[Int((facing / 45).rounded()) % 8]
                    result["compass"] = compass
                    group.leave()
                }
                if self.motion.isDeviceMotionAvailable { self.motion.startDeviceMotionUpdates() }
                self.locations.startUpdatingHeading()
            } else {
                missing.append("compass")
            }
            let finish = {
                guard !finished else { return }
                finished = true
                self.motion.stopDeviceMotionUpdates()
                self.altimeter.stopRelativeAltitudeUpdates()
                if result["barometer"] == nil, !missing.contains("barometer") { missing.append("barometer") }
                if result["compass"] == nil, CLLocationManager.headingAvailable() {
                    self.headings = []
                    self.locations.stopUpdatingHeading()
                    missing.append("compass")
                }
                result["noReading"] = missing
                call.resolve(result)
            }
            group.notify(queue: .main, execute: finish)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: finish)
        }
    }
}
