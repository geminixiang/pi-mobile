import AVFoundation
import WebKit

private let SILENCE = """
if (!window.__piAwake) {
    const rate = 8000, data = new Uint8Array(44 + rate), v = new DataView(data.buffer);
    const w = (o, s) => [...s].forEach((c, i) => (data[o + i] = c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + rate, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, rate, true); data.fill(128, 44);
    window.__piAwake = new Audio(URL.createObjectURL(new Blob([data], { type: 'audio/wav' })));
    window.__piAwake.loop = true;
}
await window.__piAwake.play();
return true;
"""

@MainActor final class ScreenAwake: NSObject {
    private enum State {
        case idle
        case playing(AVAudioEngine, Timer)
    }

    private var state = State.idle
    private var problem: String?
    private weak var webView: WKWebView?

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(returned), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func renew() async -> String? {
        if let problem { return problem }
        guard let webView else { return "keep_alive_unavailable: no WebView" }
        do {
            if case .idle = state {
                try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                let engine = AVAudioEngine()
                let format = engine.outputNode.inputFormat(forBus: 0)
                let source = Self.silentSource(format)
                engine.attach(source)
                engine.connect(source, to: engine.mainMixerNode, format: format)
                let timer = Timer(timeInterval: 180, target: self, selector: #selector(expired), userInfo: nil, repeats: false)
                RunLoop.main.add(timer, forMode: .common)
                state = .playing(engine, timer)
                try engine.start()
            }
            if case .playing(_, let timer) = state { timer.fireDate = Date().addingTimeInterval(180) }
            _ = try await webView.callAsyncJavaScript(SILENCE, in: nil, contentWorld: .page)
            return nil
        } catch {
            await stop()
            return "keep_alive_failed: \(error.localizedDescription)"
        }
    }

    func finish() async {
        if UIApplication.shared.applicationState == .active { await stop() }
    }

    @objc private func returned() {
        Task { await stop() }
    }

    @objc private func expired() {
        Task { await stop() }
    }

    private func stop() async {
        guard case .playing(let engine, let timer) = state else { return }
        timer.invalidate()
        engine.stop()
        state = .idle
        do { try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        catch { problem = "keep_alive_stop_failed: \(error.localizedDescription)" }
        do { _ = try await webView?.evaluateJavaScript("window.__piAwake?.pause()") }
        catch { problem = "web_keep_alive_stop_failed: \(error.localizedDescription)" }
        if let problem { NSLog("%@", problem) }
    }

    // why: the real-time audio render callback is not on the main actor; inheriting it traps when the app goes into the background
    nonisolated private static func silentSource(_ format: AVAudioFormat) -> AVAudioSourceNode {
        AVAudioSourceNode(format: format) { _, _, _, buffers in
            for buffer in UnsafeMutableAudioBufferListPointer(buffers) { memset(buffer.mData, 0, Int(buffer.mDataByteSize)) }
            return noErr
        }
    }
}
