import Capacitor
import Network
import SafariServices

@objc(LoopbackPlugin)
public class LoopbackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LoopbackPlugin"
    public let jsName = "Loopback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private let queue = DispatchQueue(label: "pi.loopback")
    private var listener: NWListener?
    private static let page = """
        <!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>pi mobile</title>\
        <body style="font-family:system-ui;background:#161d27;color:#ebe7e4;padding:40px 24px"><h2>登入完成</h2><p>回到 pi mobile。</p>
        """

    @objc func start(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? "/"
        guard let port = NWEndpoint.Port(rawValue: UInt16(call.getInt("port") ?? 0)) else {
            call.reject("not a port")
            return
        }
        queue.async {
            self.listener?.cancel()
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
            let listener: NWListener
            do {
                listener = try NWListener(using: parameters)
            } catch {
                call.reject("cannot listen on 127.0.0.1:\(port): \(error.localizedDescription)")
                return
            }
            self.listener = listener
            var answered = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if answered { return }
                    answered = true
                    call.resolve(["port": Int(listener.port?.rawValue ?? port.rawValue)])
                case let .failed(error):
                    if answered { return }
                    answered = true
                    call.reject("cannot listen on 127.0.0.1:\(port): \(error.localizedDescription)")
                default:
                    break
                }
            }
            listener.newConnectionHandler = { connection in self.serve(connection, path: path, port: listener.port?.rawValue ?? port.rawValue) }
            listener.start(queue: self.queue)
        }
    }

    private func serve(_ connection: NWConnection, path: String, port: UInt16) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { data, _, _, _ in
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let parts = request.split(separator: "\r\n").first?.split(separator: " ") ?? []
            let target = parts.count >= 2 ? String(parts[1]) : ""
            let ours = parts.first == "GET" && target.hasPrefix(path)
            let body = ours ? Self.page : ""
            let head = "HTTP/1.1 \(ours ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n"
            connection.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in connection.cancel() })
            guard ours else { return }
            self.notifyListeners("redirect", data: ["url": "http://127.0.0.1:\(port)\(target)"])
            self.listener?.cancel()
            self.listener = nil
            DispatchQueue.main.async {
                if let safari = self.bridge?.viewController?.presentedViewController as? SFSafariViewController {
                    safari.dismiss(animated: true)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
            call.resolve()
        }
    }
}
