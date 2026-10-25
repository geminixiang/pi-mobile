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
    private var waitingForPermission: [CAPPluginCall] = []
    private var waitingForFix: [CAPPluginCall] = []
    private var headings: [(CLHeading) -> Void] = []
    private let altimeter = CMAltimeter()
    private let motion = CMMotionManager()

    private var allowed: Bool {
        [.authorizedWhenInUse, .authorizedAlways].contains(locations.authorizationStatus)
    }

    @objc func getLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch self.locations.authorizationStatus {
            case .denied, .restricted:
                call.reject("location permission denied: the user can allow it in Settings › pi mobile › Location", "permission")
            case .notDetermined:
                guard UIApplication.shared.applicationState != .background else {
                    call.reject("pi has no location permission yet, and cannot ask for it while it is in the background. Ask the user to open pi and allow it.")
                    return
                }
                self.waitingForPermission.append(call)
                self.locations.requestWhenInUseAuthorization()
            default:
                self.locate(call)
            }
        }
    }

    private func locate(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("location is turned off on the phone", "disabled")
            return
        }
        waitingForFix.append(call)
        locations.requestLocation()
        DispatchQueue.main.asyncAfter(deadline: .now() + fixTimeout) {
            guard let index = self.waitingForFix.firstIndex(where: { $0 === call }) else { return }
            self.waitingForFix.remove(at: index)
            if let last = self.locations.location {
                self.answer(call, last, lastKnown: true)
            } else {
                call.reject("no location fix within \(Int(fixTimeout)) seconds", "timeout")
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        let waiting = waitingForPermission
        waitingForPermission = []
        for call in waiting {
            if allowed { locate(call) } else { call.reject("location permission denied", "permission") }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations updates: [CLLocation]) {
        guard let location = updates.last else { return }
        let waiting = waitingForFix
        waitingForFix = []
        for call in waiting { answer(call, location, lastKnown: false) }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard (error as? CLError)?.code != .locationUnknown else { return }
        let waiting = waitingForFix
        waitingForFix = []
        for call in waiting { call.reject("location failed: \(error.localizedDescription)", "failed") }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
        let waiting = headings
        headings = []
        manager.stopUpdatingHeading()
        for answer in waiting { answer(heading) }
    }

    private func answer(_ call: CAPPluginCall, _ location: CLLocation, lastKnown: Bool) {
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
        CLGeocoder().reverseGeocodeLocation(location) { places, _ in
            if let place = places?.first { result["address"] = Self.address(place) }
            call.resolve(result)
        }
    }

    private static func address(_ place: CLPlacemark) -> [String: Any] {
        var address: [String: Any] = [:]
        let line = [place.administrativeArea, place.locality, place.subLocality, place.thoroughfare, place.subThoroughfare].compactMap { $0 }.joined()
        if !line.isEmpty { address["line"] = line }
        if let value = place.country { address["country"] = value }
        if let value = place.administrativeArea { address["adminArea"] = value }
        if let value = place.locality { address["locality"] = value }
        if let value = place.subLocality { address["subLocality"] = value }
        if let value = place.thoroughfare { address["street"] = value }
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
            let place = item.placemark
            let line = Self.address(place)["line"] as? String
            var result: [String: Any] = ["latitude": place.coordinate.latitude, "longitude": place.coordinate.longitude]
            let label = [item.name, line].compactMap { $0 }.filter { !$0.isEmpty }
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
