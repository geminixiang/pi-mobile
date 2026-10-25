import AVFoundation
import Capacitor
import Speech

@objc(VoicePlugin)
public class VoicePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "VoicePlugin"
    public let jsName = "Voice"
    public let pluginMethods: [CAPPluginMethod] = ["available", "start", "stop", "cancel", "speak", "stopSpeaking"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private var transcription: Transcription?
    private lazy var synthesizer: AVSpeechSynthesizer = {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        return synthesizer
    }()
    private var speaking: (call: CAPPluginCall, utterance: AVSpeechUtterance)?

    @objc func available(_ call: CAPPluginCall) {
        Task {
            let dictation = await !DictationTranscriber.supportedLocales.isEmpty
            call.resolve(["available": SpeechTranscriber.isAvailable || dictation])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "zh-TW"
        AVAudioApplication.requestRecordPermission { granted in
            guard granted else {
                call.reject("需要麥克風權限才能語音輸入：設定 › pi mobile › 麥克風", "permission")
                return
            }
            Task { @MainActor in
                await self.transcription?.cancel()
                let transcription = Transcription { [weak plugin = self] event, data in plugin?.notifyListeners(event, data: data) }
                self.transcription = transcription
                do {
                    try await transcription.start(language: language)
                    call.resolve()
                } catch {
                    await transcription.cancel()
                    call.reject("語音輸入開不起來：\(error.localizedDescription)")
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        Task { @MainActor in
            await self.transcription?.stop()
            self.transcription = nil
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        Task { @MainActor in
            await self.transcription?.cancel()
            self.transcription = nil
            call.resolve()
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("nothing to say")
            return
        }
        DispatchQueue.main.async {
            self.speaking?.call.resolve(["spoken": false, "reason": "replaced by another speak call"])
            self.speaking = nil
            self.synthesizer.stopSpeaking(at: .immediate)
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: .duckOthers)
                try AVAudioSession.sharedInstance().setActive(true)
            } catch {
                call.resolve(["spoken": false, "reason": "audio unavailable: \(error.localizedDescription)"])
                return
            }
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: call.getString("language") ?? "zh-TW")
            self.speaking = (call, utterance)
            self.synthesizer.speak(utterance)
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.synthesizer.stopSpeaking(at: .immediate)
            call.resolve()
        }
    }

    private func spoke(_ utterance: AVSpeechUtterance, _ spoken: Bool, reason: String? = nil) {
        guard let (call, current) = speaking, current === utterance else { return }
        speaking = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        call.resolve(reason.map { ["spoken": spoken, "reason": $0] } ?? ["spoken": spoken])
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        spoke(utterance, true)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        spoke(utterance, false, reason: "stopped")
    }
}
