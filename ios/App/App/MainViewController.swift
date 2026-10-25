import Capacitor

class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(KeepAlivePlugin())
        bridge?.registerPluginInstance(SystemPlugin())
        bridge?.registerPluginInstance(StreamFetchPlugin())
        bridge?.registerPluginInstance(LoopbackPlugin())
        bridge?.registerPluginInstance(BotFilesPlugin())
        bridge?.registerPluginInstance(DatabasePlugin())
    }
}
