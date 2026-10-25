import Capacitor
import Foundation

private struct Failure: Error {
    let code: String
    let message: String
}

@objc(BotFilesPlugin)
public class BotFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BotFilesPlugin"
    public let jsName = "BotFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        "stat", "exists", "create", "chmod", "list", "read", "write", "truncate", "mkdir", "remove", "rename", "removeBot", "listBots", "download",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private let files = FileManager.default
    private let work = DispatchQueue(label: "pi.bot-files", attributes: .concurrent)

    private lazy var bots: URL = {
        var url = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("bots", isDirectory: true)
        try? files.createDirectory(at: url, withIntermediateDirectories: true)
        // why: the Android app keeps bot folders out of backups (allowBackup=false); iCloud backs up Application Support unless told not to
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return url.resolvingSymlinksInPath()
    }()

    private func run(_ call: CAPPluginCall, _ job: @escaping () throws -> Void) {
        work.async {
            do {
                try job()
            } catch let failure as Failure {
                call.reject(failure.message, failure.code)
            } catch {
                call.reject(error.localizedDescription, "io")
            }
        }
    }

    private func botRoot(_ call: CAPPluginCall) throws -> URL {
        let bot = call.getString("bot") ?? ""
        guard bot.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil else { throw Failure(code: "invalid", message: "bad bot id") }
        return bots.appendingPathComponent(bot, isDirectory: true)
    }

    private func resolve(_ call: CAPPluginCall, _ key: String = "path") throws -> URL {
        let root = try botRoot(call)
        let path = call.getString(key) ?? ""
        if path.hasPrefix("/") || path.contains("\0") { throw Failure(code: "invalid", message: "path must be relative: \(path)") }
        let file = (path.isEmpty ? root : root.appendingPathComponent(path)).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path == root.path || file.path.hasPrefix(root.path + "/") else { throw Failure(code: "invalid", message: "outside the folder: \(path)") }
        return file
    }

    private func notFound(_ path: String?) -> Failure {
        Failure(code: "not_found", message: "No such file or directory: \(path ?? "")")
    }

    private func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return files.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }

    private func exists(_ url: URL) -> Bool {
        files.fileExists(atPath: url.path)
    }

    private func info(_ url: URL) throws -> [String: Any] {
        let attributes = try files.attributesOfItem(atPath: url.path)
        let directory = (attributes[.type] as? FileAttributeType) == .typeDirectory
        let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        return [
            "name": url.lastPathComponent,
            "kind": directory ? "directory" : "file",
            "size": directory ? 0 : ((attributes[.size] as? NSNumber)?.int64Value ?? 0),
            "mtimeMs": Int64(modified * 1000),
            "executable": !directory && mode & 0o111 != 0,
        ]
    }

    private func number(_ call: CAPPluginCall, _ key: String) -> Int64? {
        (call.options[key] as? NSNumber)?.int64Value
    }

    @objc func stat(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            if !self.exists(file) {
                guard file.path == (try self.botRoot(call)).path else { throw self.notFound(call.getString("path")) }
                call.resolve(["name": "", "kind": "directory", "size": 0, "mtimeMs": 0, "executable": false])
                return
            }
            call.resolve(try self.info(file))
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            let root = try self.botRoot(call)
            call.resolve(["exists": self.exists(file) || file.path == root.path])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        run(call) {
            let dir = try self.resolve(call)
            if !self.exists(dir) {
                guard dir.path == (try self.botRoot(call)).path else { throw self.notFound(call.getString("path")) }
                call.resolve(["entries": []])
                return
            }
            guard self.isDirectory(dir) else { throw Failure(code: "not_directory", message: "Not a directory: \(call.getString("path") ?? "")") }
            let names = try self.files.contentsOfDirectory(atPath: dir.path)
            call.resolve(["entries": try names.map { try self.info(dir.appendingPathComponent($0)) }])
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            guard self.exists(file) else { throw self.notFound(call.getString("path")) }
            guard !self.isDirectory(file) else { throw Failure(code: "is_directory", message: "Is a directory: \(call.getString("path") ?? "")") }
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            let size = Int64(try handle.seekToEnd())
            let start = min(max(self.number(call, "offset") ?? 0, 0), size)
            let length = min(max(self.number(call, "length") ?? (size - start), 0), size - start)
            try handle.seek(toOffset: UInt64(start))
            let bytes = try handle.read(upToCount: Int(length)) ?? Data()
            if call.getBool("text") ?? false {
                call.resolve(["size": size, "text": String(decoding: bytes, as: UTF8.self)])
            } else {
                call.resolve(["size": size, "data": bytes.base64EncodedString()])
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            if file.path == (try self.botRoot(call)).path || self.isDirectory(file) {
                throw Failure(code: "is_directory", message: "Is a directory: \(call.getString("path") ?? "")")
            }
            let parent = file.deletingLastPathComponent()
            if !self.isDirectory(parent) {
                if self.exists(parent) { throw Failure(code: "not_directory", message: "Not a directory: \(parent.lastPathComponent)") }
                try self.files.createDirectory(at: parent, withIntermediateDirectories: true)
            }
            let bytes = call.getString("text").map { Data($0.utf8) } ?? Data(base64Encoded: call.getString("data") ?? "") ?? Data()
            if call.getBool("append") ?? false, self.exists(file) {
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: bytes)
            } else {
                try bytes.write(to: file, options: .atomic)
            }
            call.resolve()
        }
    }

    @objc func truncate(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            guard self.exists(file) else { throw self.notFound(call.getString("path")) }
            guard !self.isDirectory(file) else { throw Failure(code: "is_directory", message: "Is a directory: \(call.getString("path") ?? "")") }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.truncate(atOffset: UInt64(max(self.number(call, "size") ?? 0, 0)))
            call.resolve()
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            guard self.isDirectory(file.deletingLastPathComponent()) else { throw self.notFound(call.getString("path")) }
            guard !self.exists(file) else { throw Failure(code: "exists", message: "Already exists: \(call.getString("path") ?? "")") }
            if call.getBool("directory") ?? false {
                try self.files.createDirectory(at: file, withIntermediateDirectories: false)
            } else if !self.files.createFile(atPath: file.path, contents: nil) {
                throw Failure(code: "io", message: "cannot create \(file.lastPathComponent)")
            }
            call.resolve()
        }
    }

    @objc func chmod(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            guard self.exists(file) else { throw self.notFound(call.getString("path")) }
            let executable = (call.getInt("mode") ?? 0) & 0o111 != 0
            try self.files.setAttributes([.posixPermissions: executable ? 0o755 : 0o644], ofItemAtPath: file.path)
            call.resolve()
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        run(call) {
            let dir = try self.resolve(call)
            let root = try self.botRoot(call)
            let recursive = call.getBool("recursive") ?? false
            if self.isDirectory(dir) {
                if !recursive && dir.path != root.path { throw Failure(code: "exists", message: "Already exists: \(call.getString("path") ?? "")") }
                call.resolve()
                return
            }
            if self.exists(dir) { throw Failure(code: "not_directory", message: "Not a directory: \(call.getString("path") ?? "")") }
            if !recursive && dir.path != root.path && !self.isDirectory(dir.deletingLastPathComponent()) { throw self.notFound(call.getString("path")) }
            try self.files.createDirectory(at: dir, withIntermediateDirectories: true)
            call.resolve()
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            guard self.exists(file) else {
                if call.getBool("force") ?? false {
                    call.resolve()
                    return
                }
                throw self.notFound(call.getString("path"))
            }
            if file.path == (try self.botRoot(call)).path { throw Failure(code: "invalid", message: "cannot remove the folder itself") }
            if self.isDirectory(file), !(call.getBool("recursive") ?? false), !(try self.files.contentsOfDirectory(atPath: file.path)).isEmpty {
                throw Failure(code: "invalid", message: "Directory not empty: \(call.getString("path") ?? "")")
            }
            try self.files.removeItem(at: file)
            call.resolve()
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        run(call) {
            let from = try self.resolve(call, "from")
            let to = try self.resolve(call, "to")
            guard self.exists(from) else { throw self.notFound(call.getString("from")) }
            guard self.isDirectory(to.deletingLastPathComponent()) else { throw self.notFound(call.getString("to")) }
            if self.exists(to) { try self.files.removeItem(at: to) }
            try self.files.moveItem(at: from, to: to)
            call.resolve()
        }
    }

    @objc func download(_ call: CAPPluginCall) {
        run(call) {
            let file = try self.resolve(call)
            if file.path == (try self.botRoot(call)).path || self.isDirectory(file) {
                throw Failure(code: "is_directory", message: "Is a directory: \(call.getString("path") ?? "")")
            }
            guard let url = URL(string: call.getString("url") ?? ""), ["http", "https"].contains(url.scheme ?? "") else {
                throw Failure(code: "invalid", message: "url must be http or https")
            }
            var request = URLRequest(url: url, timeoutInterval: 60)
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) pi-mobile", forHTTPHeaderField: "User-Agent")
            let done = DispatchSemaphore(value: 0)
            var outcome: Result<(URL, HTTPURLResponse), Error> = .failure(Failure(code: "io", message: "no response"))
            URLSession.shared.downloadTask(with: request) { temp, response, error in
                defer { done.signal() }
                if let error {
                    outcome = .failure(error)
                    return
                }
                guard let temp, let http = response as? HTTPURLResponse else { return }
                let kept = self.files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                do {
                    try self.files.moveItem(at: temp, to: kept)
                    outcome = .success((kept, http))
                } catch {
                    outcome = .failure(error)
                }
            }.resume()
            done.wait()
            let (temp, response) = try outcome.get()
            defer { try? self.files.removeItem(at: temp) }
            guard response.statusCode < 400 else { throw Failure(code: "http", message: "HTTP \(response.statusCode) \(response.url?.absoluteString ?? url.absoluteString)") }
            let parent = file.deletingLastPathComponent()
            if !self.isDirectory(parent) { try self.files.createDirectory(at: parent, withIntermediateDirectories: true) }
            if self.exists(file) { try self.files.removeItem(at: file) }
            try self.files.moveItem(at: temp, to: file)
            let size = (try self.files.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? 0
            call.resolve(["size": size, "contentType": response.value(forHTTPHeaderField: "Content-Type") ?? "", "url": response.url?.absoluteString ?? url.absoluteString])
        }
    }

    @objc func listBots(_ call: CAPPluginCall) {
        run(call) {
            let names = try self.files.contentsOfDirectory(atPath: self.bots.path)
            let ids = names.filter { $0.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil && self.isDirectory(self.bots.appendingPathComponent($0)) }
            call.resolve(["ids": ids])
        }
    }

    @objc func removeBot(_ call: CAPPluginCall) {
        run(call) {
            let root = try self.botRoot(call)
            if self.exists(root) { try self.files.removeItem(at: root) }
            call.resolve()
        }
    }
}
