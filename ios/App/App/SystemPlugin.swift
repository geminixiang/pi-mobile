import Capacitor
import SafariServices
import UIKit

@objc(SystemPlugin)
public class SystemPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SystemPlugin"
    public let jsName = "System"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openExternal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clipboardText", returnType: CAPPluginReturnPromise),
    ]

    // why: a sign-in page answers to pi's loopback server, which iOS stops once pi leaves the foreground, so pages open in a Safari view inside pi
    @objc func openExternal(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), ["http", "https"].contains(url.scheme ?? "") else {
            call.reject("not a web address")
            return
        }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("no window to open the page in")
                return
            }
            presenter.presentedViewController?.dismiss(animated: false)
            presenter.present(SFSafariViewController(url: url), animated: true)
            call.resolve()
        }
    }

    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch call.getString("kind") {
            case "tick": UISelectionFeedbackGenerator().selectionChanged()
            case "confirm": UINotificationFeedbackGenerator().notificationOccurred(.success)
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            call.resolve()
        }
    }

    @objc func clipboardText(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["text": UIPasteboard.general.string ?? ""])
        }
    }
}
