import UIKit
import UIKit.UIGestureRecognizerSubclass
import WebKit

private let LOAD_SECONDS = 15.0
private let POLL_SECONDS = 0.2
private let USER_QUIET_SECONDS = 4.0
private let USER_WAIT_SECONDS = 60.0
private let ANSWER_SECONDS = 15.0
private let FROZEN_SECONDS = 20.0
private let SHOT_SECONDS = 5.0

private final class TouchWatcher: UIGestureRecognizer {
    private let began: () -> Void

    init(began: @escaping () -> Void) {
        self.began = began
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        began()
        state = .failed
    }
}

@MainActor private final class Awaited<Value> {
    private(set) var value: Value?
    private var waiter: CheckedContinuation<Void, Never>?

    func settle(_ value: Value?) {
        guard let waiter else { return }
        self.value = value
        self.waiter = nil
        waiter.resume()
    }

    func wait(_ seconds: Double, for ask: (Awaited) -> Void) async -> Value? {
        await withCheckedContinuation { waiter in
            self.waiter = waiter
            ask(self)
            Task {
                await pause(seconds)
                settle(nil)
            }
        }
        return value
    }
}

@MainActor final class BrowserTab: NSObject, WKNavigationDelegate, WKUIDelegate {
    let owner: BotTabs
    let id: String
    let view: WKWebView
    private let realTouch: RealTouch?
    private let changed: (BrowserTab) -> Void
    private let idle: (BrowserTab) -> Void
    private let frozen: (BrowserTab) -> Void
    private var watching: [NSKeyValueObservation] = []
    private var expiry: Task<Void, Never>?
    private var lastUserTouch = 0.0
    private var agentTouching = false
    private var gone = false
    private var dialog: String?
    private var blocked: String?
    private var unloaded: String?

    init(owner: BotTabs, id: String, view: WKWebView, realTouch: RealTouch?, changed: @escaping (BrowserTab) -> Void, idle: @escaping (BrowserTab) -> Void, frozen: @escaping (BrowserTab) -> Void) {
        self.owner = owner
        self.id = id
        self.view = view
        self.realTouch = realTouch
        self.changed = changed
        self.idle = idle
        self.frozen = frozen
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
        view.addGestureRecognizer(TouchWatcher { [weak self] in self?.touched() })
        watching = [watch(\.url), watch(\.title), watch(\.isLoading), watch(\.canGoBack), watch(\.canGoForward)]
    }

    private func watch<Value>(_ path: KeyPath<WKWebView, Value>) -> NSKeyValueObservation {
        view.observe(path) { [weak self] _, _ in
            MainActor.assumeIsolated { self.map { $0.changed($0) } }
        }
    }

    private func touched() {
        if !agentTouching { lastUserTouch = ProcessInfo.processInfo.systemUptime }
    }

    func expire(after seconds: Double?) {
        expiry?.cancel()
        expiry = seconds.map { seconds in
            Task { [weak self] in
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                guard let self else { return }
                self.idle(self)
            }
        }
    }

    func close() {
        expire(after: nil)
        watching = []
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.stopLoading()
        view.removeFromSuperview()
    }

    func revive() {
        guard gone else { return }
        gone = false
        view.reload()
    }

    func open(_ address: String) -> Result<Void, Stopped> {
        guard let url = URL(string: address), WebPages.isWeb(url) else { return .failure(Stopped("url must be http or https")) }
        view.load(URLRequest(url: url))
        return .success(())
    }

    func takeNotes() -> [String] {
        let notes = [
            blocked.map { "[pi blocked \($0). Tell the user; do not reach it another way.]" },
            unloaded.map { "[\($0)]" },
            dialog.map { "[The page showed a dialog: \($0)]" },
        ]
        blocked = nil
        unloaded = nil
        dialog = nil
        return notes.compactMap { $0 }
    }

    func awaitLoad() async {
        let end = ProcessInfo.processInfo.systemUptime + LOAD_SECONDS
        while view.isLoading && ProcessInfo.processInfo.systemUptime < end { await pause(POLL_SECONDS) }
    }

    func waitForUser() async {
        let end = ProcessInfo.processInfo.systemUptime + USER_WAIT_SECONDS
        while ProcessInfo.processInfo.systemUptime - lastUserTouch < USER_QUIET_SECONDS && ProcessInfo.processInfo.systemUptime < end { await pause(POLL_SECONDS) }
    }

    func run<Answer>(_ script: String, _ arguments: [String: Any] = [:], as _: Answer.Type = Answer.self) async -> Result<Answer, Stopped> {
        guard view.superview != nil else { return .failure(Stopped("tab \(id) is closed")) }
        if let answer: Result<Answer, Stopped> = await answer(script, arguments, within: ANSWER_SECONDS) { return answer }
        let alive: Result<Int, Stopped>? = await answer("return 1", [:], within: FROZEN_SECONDS - ANSWER_SECONDS)
        if alive != nil { return .failure(Stopped("the page did not answer in \(Int(ANSWER_SECONDS)) s")) }
        frozen(self)
        return .failure(Stopped("the page froze for \(Int(FROZEN_SECONDS)) s, so its tab was closed; do not open it again"))
    }

    func page<Answer>(_ script: String, _ arguments: [String: Any] = [:], as answer: Answer.Type = Answer.self) async -> Result<Answer, Stopped> {
        guard let source = WebPages.pageScript else { return .failure(Stopped("page-controller.js is missing from the app")) }
        // why: a user script is not added to a new web view's first, empty document, so the page script goes in with the first call that needs it, as on Android
        return await run("if (typeof window.__piPage !== 'object') { \(source) }\nconst page = window.__piPage;\nif (typeof page !== 'object') throw new Error('the page script did not load on this page');\n\(script)", arguments, as: answer)
    }

    private func answer<Answer>(_ script: String, _ arguments: [String: Any], within seconds: Double) async -> Result<Answer, Stopped>? {
        let wrapped = "try { return { ok: (await (async () => { \(script) })()) ?? {} }; } catch (failure) { return { error: String((failure && failure.message) || failure) }; }"
        return await Awaited<Result<Answer, Stopped>>().wait(seconds) { awaited in
            view.callAsyncJavaScript(wrapped, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .failure(let error): awaited.settle(.failure(Stopped(error.localizedDescription)))
                case .success(let reply):
                    let reply = reply as? [String: Any]
                    if let problem = reply?["error"] as? String { awaited.settle(.failure(Stopped(problem))) }
                    else if let value = reply?["ok"] as? Answer { awaited.settle(.success(value)) }
                    else { awaited.settle(.failure(Stopped("the page gave an answer pi cannot read"))) }
                }
            }
        }
    }

    func realTap(at point: CGPoint) async -> RealTouchOutcome {
        guard let realTouch, let screen = onScreen(point) else { return .unavailable }
        agentTouching = true
        defer { agentTouching = false }
        return await realTouch.tap(at: screen)
    }

    private func onScreen(_ point: CGPoint) -> CGPoint? {
        guard UIApplication.shared.applicationState == .active, let window = view.window, view.bounds.contains(point), point.y < view.keyboardLayoutGuide.layoutFrame.minY else { return nil }
        let inWindow = view.convert(point, to: window)
        guard window.hitTest(inWindow, with: nil)?.isDescendant(of: view) == true else { return nil }
        return window.convert(inWindow, to: window.screen.coordinateSpace)
    }

    func capture() async -> String? {
        await Awaited<String>().wait(SHOT_SECONDS) { awaited in
            view.takeSnapshot(with: nil) { [scale = view.traitCollection.displayScale] image, _ in
                guard let image else { return awaited.settle(nil) }
                let format = UIGraphicsImageRendererFormat()
                format.scale = scale / 2
                let small = UIGraphicsImageRenderer(size: image.size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: image.size)) }
                awaited.settle(small.jpegData(compressionQuality: 0.7)?.base64EncodedString())
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        WebPages.allows(navigationAction) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let failure = error as NSError
        let address = (failure.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.absoluteString ?? "the page"
        if let problem = WebPages.certificateProblem(failure) { blocked = "\(address): its certificate \(problem)" }
        else if failure.domain == NSURLErrorDomain && failure.code != NSURLErrorCancelled { unloaded = "\(address) did not load: \(failure.localizedDescription)" }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        gone = true
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        dialog = "alert: \(message)"
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        dialog = "confirm, answered cancel: \(message)"
        return false
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        dialog = "prompt, answered cancel: \(prompt)"
        return nil
    }
}
