import Capacitor

@objc protocol EditionPlugins {
    static func plugins() -> [CAPPlugin]
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
        // why: the open source edition (ios/OSS) compiles in a PiEdition class with plugins the App Store build leaves out; App.xcodeproj never names it
        let edition = (NSClassFromString("PiEdition") as? EditionPlugins.Type)?.plugins() ?? []
        edition.forEach { bridge?.registerPluginInstance($0) }
        realTouch = edition.lazy.compactMap { $0 as? RealTouch }.first
    }
}
