import Foundation

struct ScreenLine: Equatable {
    let id: Int
    let label: String
    let text: String
    let rect: CGRect
    let enabled: Bool
    let role: String
    var listed: String { "[\(id)] \(text)" }
}

struct ScreenView: Equatable {
    let package: String
    let app: String
    let size: CGSize
    let keyboard: Bool
    let headings: [String]
    let lines: [ScreenLine]
    let secretFocused: Bool

    var signature: [String] { [package, String(keyboard)] + headings + lines.map(\.text) }
    var listed: [String] { Array((headings + lines.map(\.listed)).prefix(160)) }
    var more: Int { max(0, headings.count + lines.count - 160) }

    func contains(_ text: String) -> Bool {
        let wanted = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return lines.contains { $0.label.range(of: wanted, options: .caseInsensitive) != nil }
    }

    func changes(from before: ScreenView?) -> (delta: Bool, elements: String) {
        let full = (false, listed.joined(separator: "\n"))
        guard let before, package == before.package, keyboard == before.keyboard, headings == before.headings else { return full }
        let old = Set(before.listed)
        let current = Set(listed)
        let changed = listed.filter { !old.contains($0) }
        let ids = Set(listed.map { $0.components(separatedBy: " ")[0] })
        let gone = before.listed.map { $0.components(separatedBy: " ")[0] }.filter { !ids.contains($0) }
        guard changed.count + old.subtracting(current).count <= max(listed.count, before.listed.count) / 2 else { return full }
        return (true, (changed + (gone.isEmpty ? [] : ["gone: " + gone.joined(separator: ", ")])).joined(separator: "\n"))
    }
}

@MainActor final class ScreenElements {
    private struct Identity: Hashable {
        let package: String
        let path: String
        let type: Int
        let identifier: String
        let label: String
        let contents: [String]
        let context: String
    }

    private var previous: [Identity: Int] = [:]
    private var next = 1

    func see(_ raw: [String: Any]) -> Result<ScreenView, ScreenFailure> {
        guard let tree = raw["tree"] as? [String: Any] else { return .failure(ScreenFailure(reason: "snapshot_failed: no tree")) }
        let package = raw["package"] as? String ?? ""
        let size = CGSize(width: tree["width"] as? Double ?? 0, height: tree["height"] as? Double ?? 0)
        let viewport = CGRect(origin: .zero, size: size)
        var current: [Identity: Int] = [:]
        var lines: [ScreenLine] = []
        var keyboard = false
        var secretFocused = false
        var headings: [String] = []
        func walk(_ node: [String: Any], path: String, owner: String?, context: String) {
            let type = node["type"] as? Int ?? 0
            if type == 19 { keyboard = true; return }
            if type == 50 && node["focused"] as? Bool == true { secretFocused = true }
            let label = node["label"] as? String ?? ""
            let value = node["value"] as? String ?? ""
            let identifier = node["identifier"] as? String ?? ""
            let bounds = CGRect(x: node["x"] as? Double ?? 0, y: node["y"] as? Double ?? 0, width: node["width"] as? Double ?? 0, height: node["height"] as? Double ?? 0)
            let rect = bounds.intersection(viewport)
            let visible = !rect.isNull && !rect.isEmpty
            let section = [5, 7, 8, 21].contains(type) ? context + "/" + label : context
            if [5, 7, 8].contains(type) && visible { headings.append("# app dialog/modal \(label)") }
            if type == 21 && visible { headings.append("# app \(label)") }
            // why: these are XCUIElementTypes.h ABI values; static XCTest linkage would prevent launching without the developer disk image
            let roles = [9: "button", 12: "unchecked", 26: "list", 32: "list", 33: "button", 37: "button", 40: "unchecked", 41: "unchecked", 42: "button", 43: "text", 44: "button", 45: "field", 46: "list", 48: "text", 49: "field", 50: "field", 52: "field", 75: "button", 80: "button"]
            let role = [12, 40, 41].contains(type) ? (value == "1" ? "checked" : "unchecked") : roles[type]
            var nextOwner = owner
            if let role, visible {
                let text = type == 50 ? (value.isEmpty ? label : "••••") : role == "field" && !value.isEmpty ? value : label
                if !(role == "text" && (text.isEmpty || text == owner)) {
                    let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ").replacingOccurrences(of: "\"", with: "'")
                    let clipped = flat.count > 300 ? String(flat.prefix(300)) + "…" : flat
                    let flags = [node["focused"] as? Bool == true ? "focused" : nil, node["selected"] as? Bool == true ? "selected" : nil, node["enabled"] as? Bool == false ? "disabled" : nil].compactMap { $0 }
                    let identity = Identity(package: package, path: path, type: type, identifier: identifier, label: role == "field" ? "" : text, contents: text.isEmpty && role != "field" ? screenContents(node) : [], context: section)
                    let id = previous[identity] ?? next
                    if previous[identity] == nil { next += 1 }
                    current[identity] = id
                    let description = ([role + (clipped.isEmpty ? "" : " \"\(clipped)\""), "at \(Int(rect.midX.rounded())),\(Int(rect.midY.rounded()))"] + flags).joined(separator: " ")
                    lines.append(ScreenLine(id: id, label: text, text: description, rect: rect, enabled: node["enabled"] as? Bool != false, role: role))
                    if role != "text" { nextOwner = text }
                }
            }
            for (index, child) in (node["children"] as? [[String: Any]] ?? []).enumerated() {
                walk(child, path: path + "/\(index)", owner: nextOwner, context: section)
            }
        }
        walk(tree, path: "", owner: nil, context: "")
        previous = current
        return .success(ScreenView(package: package, app: raw["app"] as? String ?? package, size: size, keyboard: keyboard, headings: headings, lines: lines, secretFocused: secretFocused))
    }
}

private func screenContents(_ node: [String: Any]) -> [String] {
    [String(node["type"] as? Int ?? 0), node["identifier"] as? String ?? "", node["label"] as? String ?? ""] +
        (node["children"] as? [[String: Any]] ?? []).flatMap(screenContents)
}
