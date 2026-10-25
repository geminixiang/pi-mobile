import Capacitor
import Foundation
import SQLite3
import UIKit

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private struct SqlError: Error {
    let message: String
}

@objc(DatabasePlugin)
public class DatabasePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DatabasePlugin"
    public let jsName = "Database"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "schema", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "export", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "pi.database")
    private var handle: OpaquePointer?
    private lazy var file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("pi-data.db")

    private func db() throws -> OpaquePointer {
        if let handle { return handle }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var opened: OpaquePointer?
        guard sqlite3_open(file.path, &opened) == SQLITE_OK, let opened else {
            throw SqlError(message: opened.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open the database")
        }
        sqlite3_exec(opened, "PRAGMA foreign_keys = ON", nil, nil, nil)
        handle = opened
        denyAttach(opened)
        return opened
    }

    private func denyAttach(_ db: OpaquePointer) {
        sqlite3_set_authorizer(db, { _, action, _, _, _, _ in
            action == SQLITE_ATTACH || action == SQLITE_DETACH ? SQLITE_DENY : SQLITE_OK
        }, nil)
    }

    private func message(_ db: OpaquePointer) -> String {
        String(cString: sqlite3_errmsg(db))
    }

    private func bind(_ statement: OpaquePointer, _ params: [Any]) {
        for (index, param) in params.enumerated() {
            let at = Int32(index + 1)
            switch param {
            case let flag as Bool:
                sqlite3_bind_int64(statement, at, flag ? 1 : 0)
            case let number as NSNumber where CFNumberIsFloatType(number):
                sqlite3_bind_double(statement, at, number.doubleValue)
            case let number as NSNumber:
                sqlite3_bind_int64(statement, at, number.int64Value)
            case let text as String:
                sqlite3_bind_text(statement, at, text, -1, transient)
            default:
                sqlite3_bind_null(statement, at)
            }
        }
    }

    private func value(_ statement: OpaquePointer, _ column: Int32) -> Any {
        switch sqlite3_column_type(statement, column) {
        case SQLITE_INTEGER: return sqlite3_column_int64(statement, column)
        case SQLITE_FLOAT: return sqlite3_column_double(statement, column)
        case SQLITE_BLOB: return "<blob \(sqlite3_column_bytes(statement, column)) bytes>"
        case SQLITE_NULL: return NSNull()
        default: return String(cString: sqlite3_column_text(statement, column))
        }
    }

    private func run(_ db: OpaquePointer, _ sql: String, _ params: [Any]) throws -> [String: Any] {
        var statement: OpaquePointer?
        let (prepared, rest) = sql.withCString { text -> (Int32, String) in
            var tail: UnsafePointer<CChar>?
            let code = sqlite3_prepare_v2(db, text, -1, &statement, &tail)
            return (code, tail.map { String(cString: $0) } ?? "")
        }
        guard prepared == SQLITE_OK, let statement else { throw SqlError(message: message(db)) }
        defer { sqlite3_finalize(statement) }
        if !rest.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ";"))).isEmpty {
            throw SqlError(message: "one statement per entry: put the rest in the next statement")
        }
        bind(statement, params)
        let before = sqlite3_total_changes(db)
        let columns = (0..<sqlite3_column_count(statement)).map { String(cString: sqlite3_column_name(statement, $0)) }
        var rows: [[Any]] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw SqlError(message: message(db)) }
            rows.append((0..<Int32(columns.count)).map { value(statement, $0) })
        }
        if !columns.isEmpty { return ["columns": columns, "rows": rows] }
        let changes = sqlite3_total_changes(db) - before
        let head = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        var result: [String: Any] = ["changes": changes]
        if changes > 0, head.hasPrefix("INSERT") || head.hasPrefix("REPLACE") { result["lastInsertId"] = sqlite3_last_insert_rowid(db) }
        return result
    }

    @objc func execute(_ call: CAPPluginCall) {
        let statements = call.getArray("statements", JSObject.self) ?? []
        queue.async {
            var index = 0
            do {
                let db = try self.db()
                sqlite3_exec(db, "BEGIN", nil, nil, nil)
                var results: [[String: Any]] = []
                for statement in statements {
                    index += 1
                    results.append(try self.run(db, statement["sql"] as? String ?? "", statement["params"] as? [Any] ?? []))
                }
                sqlite3_exec(db, "COMMIT", nil, nil, nil)
                call.resolve(["results": results])
            } catch {
                if let handle = self.handle { sqlite3_exec(handle, "ROLLBACK", nil, nil, nil) }
                call.reject("statement \(index): \((error as? SqlError)?.message ?? error.localizedDescription)")
            }
        }
    }

    @objc func schema(_ call: CAPPluginCall) {
        queue.async {
            do {
                let db = try self.db()
                let listed = try self.run(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name", [])
                let tables = try (listed["rows"] as? [[Any]] ?? []).map { row -> [String: Any] in
                    let name = row[0] as? String ?? ""
                    let counted = try self.run(db, "SELECT COUNT(*) FROM \"\(name.replacingOccurrences(of: "\"", with: "\"\""))\"", [])
                    return ["name": name, "sql": row[1] as? String ?? "", "rows": (counted["rows"] as? [[Any]])?.first?.first ?? 0]
                }
                call.resolve(["tables": tables])
            } catch {
                call.reject((error as? SqlError)?.message ?? error.localizedDescription)
            }
        }
    }

    @objc func export(_ call: CAPPluginCall) {
        queue.async {
            do {
                let db = try self.db()
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent("pi-data.db")
                if FileManager.default.fileExists(atPath: copy.path) { try FileManager.default.removeItem(at: copy) }
                // why: VACUUM INTO attaches its target, which the authorizer denies to the model's SQL; this runs on the same serial queue, so no other statement sees it lifted
                sqlite3_set_authorizer(db, nil, nil)
                defer { self.denyAttach(db) }
                _ = try self.run(db, "VACUUM INTO ?", [copy.path])
                DispatchQueue.main.async {
                    guard let presenter = self.bridge?.viewController else {
                        call.reject("no window to share from")
                        return
                    }
                    let share = UIActivityViewController(activityItems: [copy], applicationActivities: nil)
                    share.popoverPresentationController?.sourceView = presenter.view
                    share.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY, width: 0, height: 0)
                    presenter.present(share, animated: true)
                    call.resolve()
                }
            } catch {
                call.reject((error as? SqlError)?.message ?? error.localizedDescription)
            }
        }
    }
}
