@preconcurrency import Capacitor
import Foundation
import UIKit

private typealias ScreenData = [String: Any]

struct ScreenFailure: Error {
    let reason: String
    var held: Held? = nil
}

@objc(PhoneScreenPlugin)
// why: Capacitor calls from both its bridge queue and main thread; mutable plugin state is main-actor isolated and InProcess owns its serial private-API queue
public final class PhoneScreenPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "PhoneScreenPlugin"
    public let jsName = "PhoneScreen"
    public let pluginMethods: [CAPPluginMethod] = ["status", "openSettings", "openAppInfo", "read", "act"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private let session = InProcess()
    @MainActor private var elements = ScreenElements()
    @MainActor private var lastSeen: ScreenView?
    @MainActor private var awake: ScreenAwake?
    @MainActor private var busy = false

    @objc func status(_ call: CAPPluginCall) {
        Task { @MainActor in
            switch await request("status") {
            case .success: call.resolve(["allowed": true])
            case .failure(let error): call.reject(error.reason)
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        openAppInfo(call)
    }

    @objc func openAppInfo(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let url = URL(string: UIApplication.openSettingsURLString), await UIApplication.shared.open(url) else {
                call.reject("settings_unavailable: could not open pi's settings")
                return
            }
            call.resolve()
        }
    }

    private enum Observation { case read, act }

    @objc func read(_ call: CAPPluginCall) {
        observe(call, operation: .read)
    }

    @objc func act(_ call: CAPPluginCall) {
        observe(call, operation: .act)
    }

    private func observe(_ call: CAPPluginCall, operation: Observation) {
        Task { @MainActor in
            guard !busy else { call.reject("screen_busy: another read or act is running"); return }
            busy = true
            defer { busy = false }
            if awake == nil, let webView = bridge?.webView { awake = ScreenAwake(webView: webView) }
            guard let awake else { call.reject("keep_alive_unavailable: no WebView"); return }
            if let problem = await awake.renew() { call.reject(problem); return }
            let result: Result<JSObject, ScreenFailure>
            switch operation {
            case .act: result = await perform(call.getArray("steps", JSObject.self) ?? [], screenshot: call.getBool("screenshot") ?? false)
            case .read: result = await snapshot(screenshot: call.getBool("screenshot") ?? false)
            }
            await awake.finish()
            switch result {
            case .success(let value): call.resolve(value)
            case .failure(let error): call.reject(error.reason)
            }
        }
    }

    @MainActor private final class Reply {
        let result: Result<ScreenData, ScreenFailure>

        init(_ raw: ScreenData) {
            if raw["ok"] as? Bool == true, let value = raw["value"] as? ScreenData {
                result = .success(value)
            } else {
                result = .failure(ScreenFailure(reason: "\(raw["reason"] as? String ?? "invalid_reply"): \(raw["detail"] as? String ?? "")"))
            }
        }
    }

    @MainActor private func request(_ operation: String, _ arguments: JSObject = [:]) async -> Result<ScreenData, ScreenFailure> {
        let reply = await withCheckedContinuation { continuation in
            session.request(operation, arguments: arguments) { raw in
                continuation.resume(returning: Reply(raw))
            }
        }
        return reply.result
    }

    @MainActor private func perform(_ steps: [JSObject], screenshot: Bool) async -> Result<JSObject, ScreenFailure> {
        let before = lastSeen
        var done = 0
        var stopped: String?
        var did: [String] = []
        var held: Held?
        for (at, step) in steps.enumerated() {
            if let problem = await awake?.renew() { stopped = "step \(at + 1): \(problem)"; break }
            let action = step["action"] as? String ?? ""
            switch await run(step, action: action) {
            case .success(let note):
                if let note { did.append(note) }
                done += 1
            case .failure(let error):
                held = error.held
                stopped = "step \(at + 1) (\(action)): \(error.reason)"
            }
            if stopped != nil { break }
            if !["wait", "wait_for", "expect", "scroll_to"].contains(action),
               case .failure(let error) = await settle(cap: done < steps.count ? 1.5 : 2.5) {
                stopped = "after step \(at + 1) (\(action)): \(error.reason)"
                break
            }
        }
        let after = await snapshot(screenshot: screenshot, before: before)
        guard case .success(var result) = after else {
            if case .failure(let error) = after {
                return .success(["width": Double(before?.size.width ?? 0), "height": Double(before?.size.height ?? 0), "keyboard": false, "elements": "", "more": 0, "done": done, "did": did,
                    "error": stopped.map { "\($0); observation failed: \(error.reason)" } ?? "observation after \(done) steps: \(error.reason)"])
            }
            return after
        }
        result["done"] = done
        if !did.isEmpty { result["did"] = did }
        if done > 0 && lastSeen == before { result["unchanged"] = true }
        if let stopped { result["error"] = stopped }
        if let held { result["held"] = held.json }
        return .success(result)
    }

    @MainActor private func run(_ step: JSObject, action: String) async -> Result<String?, ScreenFailure> {
        let size: CGSize
        switch await see() {
        case .success(let seen):
            if handsOn(action, key: step["key"] as? String), let held = seen.held(for: action) { return .failure(ScreenFailure(reason: "held for the user", held: held)) }
            size = seen.size
        case .failure(let error): return .failure(error)
        }
        let x = step["x"] as? Double ?? size.width / 2
        let y = step["y"] as? Double ?? size.height / 2
        switch action {
        case "tap":
            if step["id"] != nil || step["text"] != nil { return await tap(step) }
            return await touch(from: CGPoint(x: x, y: y), seconds: 0).map { _ in "tapped at \(Int(x)),\(Int(y))" }
        case "wait_for": return await waitFor(step)
        case "scroll_to": return await scrollTo(step)
        case "expect":
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let seen):
                if let app = step["app"] as? String, app.caseInsensitiveCompare(seen.package) != .orderedSame && app.caseInsensitiveCompare(seen.app) != .orderedSame {
                    return .failure(ScreenFailure(reason: "expect_app: \(app)"))
                }
                if let text = step["text"] as? String, !seen.contains(text) { return .failure(ScreenFailure(reason: "expect_text: \(text)")) }
                return .success(nil)
            }
        case "long_press":
            return await touch(from: CGPoint(x: x, y: y), seconds: 0.7).map { _ in "long-pressed at \(Int(x)),\(Int(y))" }
        case "swipe":
            return await touch(from: CGPoint(x: x, y: y), to: CGPoint(x: step["to_x"] as? Double ?? x, y: step["to_y"] as? Double ?? y), seconds: (step["ms"] as? Double ?? 300) / 1000).map { _ in nil }
        case "scroll":
            let direction = step["direction"] as? String ?? "down"
            let moves: [String: CGVector] = ["down": CGVector(dx: 0, dy: -size.height * 0.35), "up": CGVector(dx: 0, dy: size.height * 0.35), "right": CGVector(dx: -size.width * 0.6, dy: 0), "left": CGVector(dx: size.width * 0.6, dy: 0)]
            guard let move = moves[direction] else { return .failure(ScreenFailure(reason: "invalid_direction: \(direction)")) }
            let from = CGPoint(x: min(max(x - move.dx / 2, 1), size.width - 1), y: min(max(y - move.dy / 2, 1), size.height - 1))
            return await touch(from: from, to: CGPoint(x: from.x + move.dx, y: from.y + move.dy), seconds: 0.35).map { _ in nil }
        case "type": return await request("type", ["text": step["text"] as? String ?? ""]).map { _ in nil }
        case "clear": return await clear()
        case "key": return await press(step["key"] as? String ?? "", size: size)
        case "open": return await request("open", ["app": step["app"] as? String ?? ""]).map { "opened \($0["name"] as? String ?? "app")" }
        case "wait":
            do { try await Task.sleep(for: .milliseconds(step["ms"] as? Int ?? 500)); return .success(nil) }
            catch { return .failure(ScreenFailure(reason: "cancelled")) }
        default: return .failure(ScreenFailure(reason: "unsupported_action: \(action)"))
        }
    }

    @MainActor private func tap(_ step: JSObject) async -> Result<String?, ScreenFailure> {
        let id = step["id"] as? Int
        let text = (step["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let until = ProcessInfo.processInfo.systemUptime + (id == nil ? 3 : 2.5)
        repeat {
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let seen):
                let matches = seen.lines.filter { line in
                    if let id { return line.id == id }
                    return line.label.caseInsensitiveCompare(text) == .orderedSame
                }
                if matches.count > 1 { return .failure(ScreenFailure(reason: "target_ambiguous: use an id")) }
                if let found = matches.first {
                    guard found.enabled else { return .failure(ScreenFailure(reason: "target_disabled")) }
                    let shown = found.web ? await revealed(found) : .success(found)
                    guard case .success(let target) = shown else { return shown.map { _ in nil } }
                    let before = seen.focusedField
                    if case .failure(let error) = await touch(from: CGPoint(x: target.rect.midX, y: target.rect.midY), seconds: 0) { return .failure(error) }
                    guard target.role == "field", let before, before.label != target.label else { return .success("tapped \(target.listed)") }
                    return await focused(target, from: before).map { "tapped \(target.listed)" }
                }
                if let id { return .failure(ScreenFailure(reason: "target_gone: \(id)")) }
            }
            if case .failure(let error) = await pause(0.1) { return .failure(error) }
        } while ProcessInfo.processInfo.systemUptime < until
        return .failure(ScreenFailure(reason: "target_missing"))
    }

    @MainActor private func focused(_ target: ScreenLine, from before: ScreenLine) async -> Result<Void, ScreenFailure> {
        let until = ProcessInfo.processInfo.systemUptime + 1
        repeat {
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let seen):
                if seen.lines.contains(where: { $0.focused && $0.role == "field" && $0.label != before.label }) { return .success(()) }
            }
            if case .failure(let error) = await pause(0.1) { return .failure(error) }
        } while ProcessInfo.processInfo.systemUptime < until
        return .failure(ScreenFailure(reason: "not_focused: [\(target.id)] did not take the cursor, which stayed in \(before.listed); something on top of it (a suggestion or popup) took the tap. Close that, read the screen, and tap again"))
    }

    @MainActor private func revealed(_ target: ScreenLine) async -> Result<ScreenLine, ScreenFailure> {
        guard let ref = elements.refs[target.id] else { return .failure(ScreenFailure(reason: "target_gone: \(target.id)")) }
        if case .failure(let error) = await request("reveal", ["ref": ref]) { return .failure(error) }
        if case .failure(let error) = await settle(cap: 1) { return .failure(error) }
        switch await see() {
        case .failure(let error): return .failure(error)
        case .success(let seen):
            let same = seen.lines.filter { $0.role == target.role && $0.label == target.label }
            let distance = { (line: ScreenLine) in hypot(line.rect.midX - target.rect.midX, line.rect.midY - target.rect.midY) }
            guard let moved = seen.lines.first(where: { $0.id == target.id }) ?? same.min(by: { distance($0) < distance($1) }) else { return .failure(ScreenFailure(reason: "target_gone: \(target.id)")) }
            return .success(moved)
        }
    }

    @MainActor private func waitFor(_ step: JSObject) async -> Result<String?, ScreenFailure> {
        let text = step["text"] as? String ?? ""
        let gone = step["gone"] as? Bool ?? false
        let until = ProcessInfo.processInfo.systemUptime + Double(step["ms"] as? Int ?? 3000) / 1000
        repeat {
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let seen):
                if !seen.lines.isEmpty && seen.contains(text) != gone { return .success(nil) }
            }
            if case .failure(let error) = await pause(0.1) { return .failure(error) }
        } while ProcessInfo.processInfo.systemUptime < until
        return .failure(ScreenFailure(reason: "wait_timeout: \(text)"))
    }

    @MainActor private func scrollTo(_ step: JSObject) async -> Result<String?, ScreenFailure> {
        let text = step["text"] as? String ?? ""
        let until = ProcessInfo.processInfo.systemUptime + 15
        var previous: [String]?
        for attempt in 0...12 {
            let seen: ScreenView
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let value): seen = value
            }
            if seen.contains(text) { return .success(nil) }
            if seen.signature == previous { return .failure(ScreenFailure(reason: "scroll_end: \(text)")) }
            if attempt == 12 || ProcessInfo.processInfo.systemUptime >= until { return .failure(ScreenFailure(reason: "scroll_limit: \(text)")) }
            guard let list = seen.lines.filter({ $0.role == "list" }).max(by: { $0.rect.width * $0.rect.height < $1.rect.width * $1.rect.height }) else {
                return .failure(ScreenFailure(reason: "no_scrollable_list"))
            }
            previous = seen.signature
            let scroll: JSObject = ["action": "scroll", "direction": step["direction"] as? String ?? "down", "x": Double(list.rect.midX), "y": Double(list.rect.midY)]
            if case .failure(let error) = await run(scroll, action: "scroll") { return .failure(error) }
            if case .failure(let error) = await settle(cap: min(1.5, max(0, until - ProcessInfo.processInfo.systemUptime))) { return .failure(error) }
        }
        return .failure(ScreenFailure(reason: "scroll_limit: \(text)"))
    }

    @MainActor private func settle(cap: Double) async -> Result<Void, ScreenFailure> {
        let start = ProcessInfo.processInfo.systemUptime
        var previous: [String]?
        var changed = start
        var observedChange = false
        repeat {
            switch await see() {
            case .failure(let error): return .failure(error)
            case .success(let seen):
                if let previous, previous != seen.signature { changed = ProcessInfo.processInfo.systemUptime; observedChange = true }
                previous = seen.signature
            }
            let now = ProcessInfo.processInfo.systemUptime
            if now - changed >= 0.35 && (observedChange || now - start >= 1) { return .success(()) }
            if case .failure(let error) = await pause(0.1) { return .failure(error) }
        } while ProcessInfo.processInfo.systemUptime - start < cap
        return .success(())
    }

    private func pause(_ seconds: Double) async -> Result<Void, ScreenFailure> {
        do { try await Task.sleep(for: .seconds(seconds)); return .success(()) }
        catch { return .failure(ScreenFailure(reason: "cancelled")) }
    }

    @MainActor private func touch(from: CGPoint, to: CGPoint? = nil, seconds: Double) async -> Result<ScreenData, ScreenFailure> {
        let orientation = bridge?.webView?.window?.windowScene?.effectiveGeometry.interfaceOrientation.rawValue ?? UIInterfaceOrientation.portrait.rawValue
        var args: JSObject = ["x": Double(from.x), "y": Double(from.y), "seconds": seconds, "orientation": orientation]
        if let to { args["to_x"] = Double(to.x); args["to_y"] = Double(to.y) }
        return await request("touch", args)
    }

    @MainActor private func clear() async -> Result<String?, ScreenFailure> {
        switch await request("snapshot") {
        case .failure(let error): return .failure(error)
        case .success(let raw):
            guard let tree = raw["tree"] as? ScreenData,
                  let field = screenNodes(tree).first(where: { ($0["focused"] as? Bool == true) && [45, 49, 50, 52].contains($0["type"] as? Int ?? 0) }) else {
                return .failure(ScreenFailure(reason: "no_focused_field: tap a text field first"))
            }
            let value = field["value"] as? String ?? ""
            guard !value.isEmpty else { return .success(nil) }
            return await request("type", ["text": String(repeating: "\u{8}\u{7f}", count: value.utf16.count)]).map { _ in nil }
        }
    }

    @MainActor private func press(_ key: String, size: CGSize) async -> Result<String?, ScreenFailure> {
        switch key {
        case "home": return await request("home").map { _ in "pressed Home" }
        case "enter": return await request("type", ["text": "\n"]).map { _ in nil }
        case "back":
            return await touch(from: CGPoint(x: 1, y: size.height / 2), to: CGPoint(x: size.width * 0.8, y: size.height / 2), seconds: 0.3).map { _ in "swiped back from the left edge" }
        case "notifications": return await touch(from: CGPoint(x: size.width * 0.25, y: 1), to: CGPoint(x: size.width * 0.25, y: size.height * 0.7), seconds: 0.3).map { _ in nil }
        case "quick_settings": return await touch(from: CGPoint(x: size.width - 10, y: 1), to: CGPoint(x: size.width - 10, y: size.height * 0.7), seconds: 0.3).map { _ in nil }
        default: return .failure(ScreenFailure(reason: "unsupported_key: \(key)"))
        }
    }

    @MainActor private func see() async -> Result<ScreenView, ScreenFailure> {
        switch await request("snapshot") {
        case .failure(let error): return .failure(error)
        case .success(let raw): return elements.see(raw)
        }
    }

    @MainActor private func snapshot(screenshot: Bool, before: ScreenView? = nil) async -> Result<JSObject, ScreenFailure> {
        switch await see() {
        case .failure(let error): return .failure(error)
        case .success(let seen):
            let changes = seen.changes(from: before)
            lastSeen = seen
            var result: JSObject = ["width": Double(seen.size.width), "height": Double(seen.size.height), "package": seen.package, "app": seen.app, "keyboard": seen.keyboard, "elements": changes.elements, "more": seen.more, "delta": changes.delta]
            if screenshot {
                switch await request("screenshot") {
                case .failure(let error): result["shotError"] = error.reason
                case .success(let shot):
                    if let png = shot["png"] as? String, let data = Data(base64Encoded: png), let image = UIImage(data: data), image.size.width > 0 {
                        let width = seen.size.width
                        let size = CGSize(width: width, height: image.size.height * width / image.size.width)
                        let format = UIGraphicsImageRendererFormat()
                        format.scale = 1
                        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                        if let jpeg = small.jpegData(compressionQuality: 0.7) { result["jpeg"] = jpeg.base64EncodedString() }
                        else { result["shotError"] = "screenshot_encoding_failed" }
                    } else { result["shotError"] = "screenshot_decode_failed" }
                }
            }
            return .success(result)
        }
    }
}

private func screenNodes(_ tree: ScreenData) -> [ScreenData] {
    [tree] + (tree["children"] as? [ScreenData] ?? []).flatMap(screenNodes)
}
