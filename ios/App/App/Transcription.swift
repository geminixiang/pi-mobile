import AVFoundation
import Speech

@available(iOS 26.0, *)
final class Transcription {
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var inputs: AsyncStream<AnalyzerInput>.Continuation?
    private var reading: Task<Void, Never>?
    private let emit: (String, [String: Any]) -> Void

    init(emit: @escaping (String, [String: Any]) -> Void) {
        self.emit = emit
    }

    func start(language: String) async throws {
        let locale = Locale(identifier: language)
        let module: any SpeechModule
        let results: AsyncThrowingStream<(text: String, isFinal: Bool), Error>
        if SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
            module = transcriber
            results = Self.texts(transcriber.results.map { (String($0.text.characters), $0.isFinal) })
        } else if let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            let transcriber = DictationTranscriber(locale: supported, preset: .progressiveShortDictation)
            module = transcriber
            results = Self.texts(transcriber.results.map { (String($0.text.characters), $0.isFinal) })
        } else {
            throw NSError(domain: "pi.voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "這台裝置不支援 \(language) 的語音辨識"])
        }
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await install.downloadAndInstall()
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module]) else {
            throw NSError(domain: "pi.voice", code: 2, userInfo: [NSLocalizedDescriptionKey: "語音模型還沒裝好"])
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let analyzer = SpeechAnalyzer(modules: [module])
        self.analyzer = analyzer
        let (stream, inputs) = AsyncStream.makeStream(of: AnalyzerInput.self)
        self.inputs = inputs
        let source = engine.inputNode.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: source, to: format) else {
            throw NSError(domain: "pi.voice", code: 3, userInfo: [NSLocalizedDescriptionKey: "麥克風的音訊格式轉不過去"])
        }
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: source) { [weak self] buffer, _ in
            self?.level(buffer)
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / source.sampleRate) + 1
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var fed = false
            var failure: NSError?
            converter.convert(to: converted, error: &failure) { _, status in
                if fed {
                    status.pointee = .noDataNow
                    return nil
                }
                fed = true
                status.pointee = .haveData
                return buffer
            }
            if failure == nil, converted.frameLength > 0 { inputs.yield(AnalyzerInput(buffer: converted)) }
        }
        reading = Task { [weak self] in
            var finished = ""
            var volatile = ""
            do {
                for try await result in results {
                    if result.isFinal {
                        finished += result.text
                        volatile = ""
                    } else {
                        volatile = result.text
                    }
                    self?.emit("partial", ["text": finished + volatile])
                }
                self?.emit("final", ["text": finished + volatile])
            } catch is CancellationError {
            } catch {
                self?.emit("error", ["code": (error as NSError).code, "message": error.localizedDescription])
            }
            self?.emit("end", [:])
        }
        try await analyzer.start(inputSequence: stream)
        engine.prepare()
        try engine.start()
        emit("ready", [:])
    }

    private static func texts<S: AsyncSequence>(_ sequence: S) -> AsyncThrowingStream<(text: String, isFinal: Bool), Error> where S.Element == (String, Bool) {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await (text, isFinal) in sequence { continuation.yield((text, isFinal)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func level(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        let decibels = 20 * log10(max(sqrt(sum / Float(buffer.frameLength)), 1e-6))
        // why: the composer scales Android's recognizer rms, roughly -2 to 10; quiet speech near -50 dBFS and loud near -10 map onto that range
        emit("level", ["rms": (decibels + 50) / 40 * 12 - 2])
    }

    private func release() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        inputs?.finish()
        inputs = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func stop() async {
        release()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        analyzer = nil
    }

    func cancel() async {
        release()
        reading?.cancel()
        await analyzer?.cancelAndFinishNow()
        analyzer = nil
    }
}
