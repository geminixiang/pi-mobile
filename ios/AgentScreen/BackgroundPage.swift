import Capacitor
import WebKit

final class BackgroundPage: NSObject, BackgroundRunner {
    init(configuring configuration: WKWebViewConfiguration) {
        super.init()
        let preferences = configuration.preferences
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        let enable = Selector(("_setNotificationsEnabled:"))
        if preferences.responds(to: enable) { unsafeBitCast(preferences.method(for: enable), to: SetBool.self)(preferences, enable, true) }
        // why: on a device WebKit sends permission requests to the system push service, which refuses anything but a Home Screen web app, so the UI delegate is never asked
        let features = (WKPreferences.self as AnyObject).perform(Selector(("_features")))?.takeUnretainedValue() as? [NSObject] ?? []
        let toggle = Selector(("_setEnabled:forFeature:"))
        if let builtIn = features.first(where: { ($0.value(forKey: "key") as? String) == "BuiltInNotificationsEnabled" }), preferences.responds(to: toggle) {
            typealias SetFeature = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
            unsafeBitCast(preferences.method(for: toggle), to: SetFeature.self)(preferences, toggle, false, builtIn)
        }
        let allow: @convention(block) (AnyObject, AnyObject, AnyObject, @escaping (Bool) -> Void) -> Void = { _, _, _, decide in decide(true) }
        class_addMethod(WebViewDelegationHandler.self, Selector(("_webView:requestNotificationPermissionForSecurityOrigin:decisionHandler:")), imp_implementationWithBlock(allow), "v@:@@@?")
    }

    // why: a page granted notifications holds a WebKit background activity, so its process is not suspended while the app runs; evaluateJavaScript counts as the user gesture the request needs
    @MainActor func keepRunning(_ webView: WKWebView) {
        webView.evaluateJavaScript("Notification.requestPermission()")
    }
}
