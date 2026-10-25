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

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private lazy var synthesizer: AVSpeechSynthesizer = {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        return synthesizer
    }()
    private var speaking: (call: CAPPluginCall, utterance: AVSpeechUtterance)?
    private var transcription: AnyObject?

    @objc func available(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *) {
            call.resolve(["available": true])
            return
        }
        call.resolve(["available": SFSpeechRecognizer(locale: Locale(identifier: "zh-TW"))?.isAvailable ?? false])
    }

    @objc func start(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "zh-TW"
        // why: SFSpeechRecognizer stops with error 201 when Siri and keyboard Dictation are off; SpeechAnalyzer (iOS 26) runs on the device without either
        if #available(iOS 26.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                guard granted else {
                    call.reject("需要麥克風權限才能語音輸入：設定 › pi mobile › 麥克風", "permission")
                    return
                }
                Task { @MainActor in
                    let transcription = Transcription { [weak self] event, data in self?.notifyListeners(event, data: data) }
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
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("需要語音辨識權限才能語音輸入：設定 › pi mobile › 語音辨識", "permission")
                return
            }
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        call.reject("需要麥克風權限才能語音輸入：設定 › pi mobile › 麥克風", "permission")
                        return
                    }
                    do {
                        try self.listen(language)
                        call.resolve()
                    } catch {
                        self.finish()
                        call.reject("語音輸入開不起來：\(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private func listen(_ language: String) throws {
        finish()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)), recognizer.isAvailable else {
            throw NSError(domain: "pi.voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "這支手機不支援 \(language) 的語音辨識"])
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            request.append(buffer)
            self?.report(level: buffer)
        }
        engine.prepare()
        try engine.start()
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                self.notifyListeners(result.isFinal ? "final" : "partial", data: ["text": text])
                if result.isFinal { self.finish() }
            }
            if let error, result?.isFinal != true {
                let nsError = error as NSError
                let silent = nsError.domain == "kAFAssistantErrorDomain" && [203, 216, 1110].contains(nsError.code)
                if !silent { self.notifyListeners("error", data: ["code": nsError.code, "message": error.localizedDescription]) }
                self.finish()
            }
        }
        notifyListeners("ready", data: [:])
    }

    private func report(level buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        let decibels = 20 * log10(max(sqrt(sum / Float(buffer.frameLength)), 1e-6))
        // why: the composer scales Android's recognizer rms, roughly -2 to 10; quiet speech near -50 dBFS and loud near -10 map onto that range
        notifyListeners("level", data: ["rms": (decibels + 50) / 40 * 12 - 2])
    }

    private func finish() {
        guard request != nil || task != nil else { return }
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        notifyListeners("end", data: [:])
    }

    @objc func stop(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *), let transcription = transcription as? Transcription {
            Task { @MainActor in
                await transcription.stop()
                call.resolve()
            }
            return
        }
        DispatchQueue.main.async {
            if self.engine.isRunning { self.engine.stop() }
            self.engine.inputNode.removeTap(onBus: 0)
            self.request?.endAudio()
            call.resolve()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if #available(iOS 26.0, *), let transcription = transcription as? Transcription {
            Task { @MainActor in
                await transcription.cancel()
                call.resolve()
            }
            return
        }
        DispatchQueue.main.async {
            self.task?.cancel()
            self.finish()
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
