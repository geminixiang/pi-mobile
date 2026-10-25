import Capacitor

@objc(StreamFetchPlugin)
public class StreamFetchPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "StreamFetchPlugin"
    public let jsName = "StreamFetch"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
    ]

    private let lock = NSLock()
    private var ids: [Int: String] = [:]
    private var tasks: [String: URLSessionDataTask] = [:]
    private var next = 0
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 120
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    @objc func start(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text) else {
            call.reject("not a web address")
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = call.getString("method") ?? "GET"
        for (key, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: key) }
        }
        if let base64 = call.getString("bodyBase64") {
            request.httpBody = Data(base64Encoded: base64)
        } else if let body = call.getString("body") {
            request.httpBody = Data(body.utf8)
        }
        let task = session.dataTask(with: request)
        lock.lock()
        next += 1
        let id = "f\(next)"
        ids[task.taskIdentifier] = id
        tasks[id] = task
        lock.unlock()
        call.resolve(["id": id])
        task.resume()
    }

    @objc func abort(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        lock.lock()
        let task = tasks.removeValue(forKey: id)
        if let task { ids.removeValue(forKey: task.taskIdentifier) }
        lock.unlock()
        task?.cancel()
        call.resolve()
    }

    private func id(of task: URLSessionTask, finished: Bool = false) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let id = ids[task.taskIdentifier] else { return nil }
        if finished {
            ids.removeValue(forKey: task.taskIdentifier)
            tasks.removeValue(forKey: id)
        }
        return id
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let id = id(of: dataTask), let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String { headers[key.lowercased()] = "\(value)" }
        }
        notifyListeners("head", data: ["id": id, "status": http.statusCode, "headers": headers])
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let id = id(of: dataTask) else { return }
        notifyListeners("chunk", data: ["id": id, "data": data.base64EncodedString()])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = id(of: task, finished: true) else { return }
        if let error {
            notifyListeners("error", data: ["id": id, "message": error.localizedDescription])
        } else {
            notifyListeners("end", data: ["id": id])
        }
    }
}
