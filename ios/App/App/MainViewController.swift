import Capacitor

@objc protocol EditionPlugins {
    static func plugins() -> [CAPPlugin]
}

class MainViewController: CAPBridgeViewController {
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
        // why: the open source edition (ios/OSS) compiles in a PiEdition class with plugins the App Store build leaves out; App.xcodeproj never names it
        (NSClassFromString("PiEdition") as? EditionPlugins.Type)?.plugins().forEach { bridge?.registerPluginInstance($0) }
    }
}
