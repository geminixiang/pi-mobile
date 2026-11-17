import Capacitor
import WebKit

@objc protocol EditionPlugins {
    static func plugins() -> [CAPPlugin]
    @objc optional static func backgroundRunner(_ configuration: WKWebViewConfiguration) -> BackgroundRunner
}

@objc protocol BackgroundRunner {
    @MainActor func keepRunning(_ webView: WKWebView)
}

enum RealTouchOutcome {
    case delivered
    case unavailable
    case unconfirmed(String)
}

@MainActor protocol RealTouch: AnyObject {
    func tap(at screenPoint: CGPoint) async -> RealTouchOutcome
}

class MainViewController: CAPBridgeViewController {
    private(set) var realTouch: RealTouch?
    private(set) var backgroundRunner: BackgroundRunner?

    override open func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        backgroundRunner = edition?.backgroundRunner?(configuration)
        return configuration
    }

    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(KeepAlivePlugin())
        bridge?.registerPluginInstance(SystemPlugin())
        bridge?.registerPluginInstance(StreamFetchPlugin())
        bridge?.registerPluginInstance(LoopbackPlugin())
        bridge?.registerPluginInstance(BotFilesPlugin())
        bridge?.registerPluginInstance(DatabasePlugin())
        bridge?.registerPluginInstance(PhonePlugin())
        bridge?.registerPluginInstance(HealthPlugin())
        bridge?.registerPluginInstance(CalendarPlugin())
        bridge?.registerPluginInstance(VoicePlugin())
        bridge?.registerPluginInstance(ContactsPlugin())
        bridge?.registerPluginInstance(PhotosPlugin())
        bridge?.registerPluginInstance(AppsPlugin())
        bridge?.registerPluginInstance(BrowserPlugin())
        let plugins = edition?.plugins() ?? []
        plugins.forEach { bridge?.registerPluginInstance($0) }
        realTouch = plugins.lazy.compactMap { $0 as? RealTouch }.first
    }
}

// why: the open source edition (ios/OSS) compiles in a PiEdition class with plugins the App Store build leaves out; App.xcodeproj never names it
private let edition = NSClassFromString("PiEdition") as? EditionPlugins.Type
