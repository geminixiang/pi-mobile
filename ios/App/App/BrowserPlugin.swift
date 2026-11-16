@preconcurrency import Capacitor
import UIKit
import WebKit

private let MAX_TABS = 8
private let IDLE_SECONDS = 15.0 * 60
private let FADE_SECONDS = 0.14
private let TABS_KEY = "browser.tabs:"
private let FORGOTTEN_KEY = "browser.forgotten"
private let FACTS = "return { ready: document.readyState, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000) };"

struct Placement {
    let frame: CGRect
    let radius: CGFloat
}

@MainActor final class BotTabs {
    let bot: String
    var open: [BrowserTab] = []
    var active: String?
    var next = 1
    var shownAt: Placement?
    var size: CGSize

    init(bot: String, size: CGSize) {
        self.bot = bot
        self.size = size
    }

    func tab(_ id: String?) -> BrowserTab? {
        open.first { $0.id == id }
    }
}

@objc(BrowserPlugin)
// why: Capacitor's CAPPlugin is unannotated Objective-C, called from the main thread and the bridge queue; this plugin adds only lets and main-actor state
public final class BrowserPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "BrowserPlugin"
    public let jsName = "Browser"
    public let pluginMethods: [CAPPluginMethod] = ["read", "act", "go", "newTab", "selectTab", "closeTab", "tabs", "show", "hide", "peek", "forget"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    @MainActor private var bots: [String: BotTabs] = [:]

    override public func load() {
        Task { @MainActor in
            for profile in UserDefaults.standard.stringArray(forKey: FORGOTTEN_KEY) ?? [] { await forgetStore(profile) }
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        reply(call) {
            await self.tabOf(call).then { await self.snapshot($0, screenshot: call.getBool("screenshot") ?? false, error: nil).map(Optional.some) }
        }
    }

    @objc func act(_ call: CAPPluginCall) {
        reply(call) {
            await self.tabOf(call).then { tab in
                var did: [String] = []
                var stopped: String?
                for (at, json) in (call.getArray("steps", JSObject.self) ?? []).enumerated() {
                    await tab.waitForUser()
                    let ran: Result<String?, Stopped> = if let step = Step.of(json) { await tab.perform(step) } else { .failure(Stopped("pi cannot read this step")) }
                    switch ran {
                    case .success(let note): if let note { did.append(note) }
                    case .failure(let stop): stopped = "step \(at + 1) (\(json["action"] as? String ?? "")): \(stop.reason)"
                    }
                    if stopped != nil { break }
                }
                return await self.snapshot(tab, screenshot: call.getBool("screenshot") ?? false, error: stopped)
                    .map { page in did.isEmpty ? page : page.merging(["did": did]) { $1 } }
                    .mapError { Stopped(stopped ?? $0.reason) }
            }
        }
    }

    @objc func go(_ call: CAPPluginCall) {
        reply(call) {
            self.tabOf(call).flatMap { tab in
                switch call.getString("action") {
                case "open": return tab.open(call.getString("url") ?? "").map { nil }
                case "back": if tab.view.canGoBack { tab.view.goBack() }
                case "forward": if tab.view.canGoForward { tab.view.goForward() }
                case "reload": tab.view.reload()
                default: return .failure(Stopped("action is back, forward, reload, or open"))
                }
                return .success(nil)
            }
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        reply(call) {
            self.tabOf(call).flatMap { tab in
                guard let x = call.getDouble("x"), let y = call.getDouble("y"), let width = call.getDouble("width"), let height = call.getDouble("height"), let radius = call.getDouble("radius") else {
                    return .failure(Stopped("x, y, width, height and radius are required"))
                }
                let placement = Placement(frame: CGRect(x: x, y: y, width: max(1, width), height: max(1, height)), radius: radius)
                tab.owner.size = placement.frame.size
                tab.owner.shownAt = placement
                self.attach(tab, placement, fade: true)
                return .success(nil)
            }
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        reply(call) {
            if let tabs = self.bots[call.getString("bot") ?? ""] {
                tabs.shownAt = nil
                tabs.open.forEach(self.park)
            }
            return .success(nil)
        }
    }

    @objc func peek(_ call: CAPPluginCall) {
        reply(call) {
            let tabs = self.bots[call.getString("bot") ?? ""]
            guard let jpeg = await tabs?.tab(tabs?.active)?.capture() else { return .success([:]) }
            return .success(["jpeg": jpeg])
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        reply(call) {
            let bot = call.getString("bot") ?? ""
            UserDefaults.standard.removeObject(forKey: TABS_KEY + bot)
            if let tabs = self.bots.removeValue(forKey: bot) { self.closeAll(tabs) }
            await self.forgetStore(self.profileOf(bot))
            return .success(nil)
        }
    }

    @objc func newTab(_ call: CAPPluginCall) {
        reply(call) {
            self.botTabs(call).flatMap { tabs in
                self.restore(tabs)
                guard tabs.open.count < MAX_TABS else { return .failure(Stopped("a Bot keeps at most \(MAX_TABS) tabs; close one first")) }
                return self.create(tabs).map { tab in
                    self.select(tabs, tab.id)
                    return ["tab": tab.id]
                }
            }
        }
    }

    @objc func selectTab(_ call: CAPPluginCall) {
        reply(call) {
            self.botTabs(call).flatMap { tabs in
                let id = call.getString("tab") ?? ""
                self.restore(tabs)
                guard tabs.tab(id) != nil else { return .failure(Stopped("tab \(id) is not open")) }
                self.select(tabs, id)
                return .success(nil)
            }
        }
    }

    @objc func closeTab(_ call: CAPPluginCall) {
        reply(call) {
            self.botTabs(call).flatMap { tabs in
                let id = call.getString("tab") ?? ""
                self.restore(tabs)
                guard tabs.tab(id) != nil else { return .failure(Stopped("tab \(id) is not open")) }
                self.close(tabs, id)
                return .success(nil)
            }
        }
    }

    @objc func tabs(_ call: CAPPluginCall) {
        reply(call) {
            let bot = call.getString("bot") ?? ""
            if let tabs = self.bots[bot], !tabs.open.isEmpty { return .success(self.listing(tabs)) }
            let saved = (UserDefaults.standard.stringArray(forKey: TABS_KEY + bot) ?? []).enumerated().map { ["id": String($0.offset + 1), "url": $0.element, "title": ""] }
            return .success(saved.isEmpty ? ["bot": bot, "tabs": saved] : ["bot": bot, "tabs": saved, "active": "1"])
        }
    }

    private func reply(_ call: CAPPluginCall, _ job: @escaping @MainActor () async -> Result<JSObject?, Stopped>) {
        Task { @MainActor in
            switch await job() {
            case .success(let value): if let value { call.resolve(value) } else { call.resolve() }
            case .failure(let stop): call.reject(stop.reason)
            }
        }
    }

    private func profileOf(_ bot: String) -> String {
        "bot-\(bot)"
    }

    @MainActor private func forgetStore(_ profile: String) async {
        let removed = await WebPages.forget(profile: profile)
        let waiting = (UserDefaults.standard.stringArray(forKey: FORGOTTEN_KEY) ?? []).filter { $0 != profile }
        UserDefaults.standard.set(removed ? waiting : waiting + [profile], forKey: FORGOTTEN_KEY)
    }

    @MainActor private func botTabs(_ call: CAPPluginCall) -> Result<BotTabs, Stopped> {
        guard let bot = call.getString("bot"), !bot.isEmpty else { return .failure(Stopped("bot is required")) }
        if let tabs = bots[bot] { return .success(tabs) }
        guard let pi = bridge?.webView else { return .failure(Stopped("pi has no window to browse in")) }
        let tabs = BotTabs(bot: bot, size: pi.bounds.size)
        bots[bot] = tabs
        return .success(tabs)
    }

    @MainActor private func tabOf(_ call: CAPPluginCall) -> Result<BrowserTab, Stopped> {
        botTabs(call).flatMap { tabs in
            let wanted = call.getString("tab")
            restore(tabs)
            if let wanted, tabs.tab(wanted) == nil { return .failure(Stopped("tab \(wanted) is not open; open tabs: \(tabs.open.map(\.id).joined(separator: ", "))")) }
            return (tabs.tab(wanted ?? tabs.active).map(Result.success) ?? create(tabs)).map { tab in
                tab.revive()
                tab.expire(after: IDLE_SECONDS)
                return tab
            }
        }
    }

    @MainActor private func listing(_ tabs: BotTabs) -> JSObject {
        let list = tabs.open.map { ["id": $0.id, "url": $0.view.url?.absoluteString ?? "", "title": $0.view.title ?? ""] }
        return tabs.active.map { ["bot": tabs.bot, "tabs": list, "active": $0] } ?? ["bot": tabs.bot, "tabs": list]
    }

    @MainActor private func announceTabs(_ tabs: BotTabs) {
        remember(tabs)
        notifyListeners("tabs", data: listing(tabs))
    }

    @MainActor private func announce(_ tab: BrowserTab) {
        notifyListeners("page", data: [
            "bot": tab.owner.bot,
            "tab": tab.id,
            "url": tab.view.url?.absoluteString ?? "",
            "title": tab.view.title ?? "",
            "loading": tab.view.isLoading,
            "canGoBack": tab.view.canGoBack,
            "canGoForward": tab.view.canGoForward,
        ])
        if !tab.view.isLoading { remember(tab.owner) }
    }

    @MainActor private func remember(_ tabs: BotTabs) {
        UserDefaults.standard.set(tabs.open.map { $0.view.url?.absoluteString ?? "" }, forKey: TABS_KEY + tabs.bot)
    }

    @MainActor private func restore(_ tabs: BotTabs) {
        guard tabs.open.isEmpty, let saved = UserDefaults.standard.stringArray(forKey: TABS_KEY + tabs.bot) else { return }
        tabs.next = 1
        for address in saved {
            if case .success(let tab) = create(tabs) { _ = tab.open(address) }
        }
        UserDefaults.standard.set(saved, forKey: TABS_KEY + tabs.bot)
    }

    @MainActor private func create(_ tabs: BotTabs) -> Result<BrowserTab, Stopped> {
        guard let pi = bridge?.webView, let host = pi.superview else { return .failure(Stopped("pi has no window to browse in")) }
        let tab = BrowserTab(owner: tabs, id: String(tabs.next), view: WebPages.create(profile: profileOf(tabs.bot), size: tabs.size), realTouch: (bridge?.viewController as? MainViewController)?.realTouch, changed: announce, idle: expire, frozen: freeze)
        tabs.next += 1
        tabs.open.append(tab)
        if tabs.active == nil { tabs.active = tab.id }
        // why: WebKit stops drawing a web view outside the window and slows its timers to about one a second, so a tab nobody is looking at stays in the window, behind pi
        host.insertSubview(tab.view, belowSubview: pi)
        tab.expire(after: IDLE_SECONDS)
        announceTabs(tabs)
        return .success(tab)
    }

    @MainActor private func expire(_ tab: BrowserTab) {
        let tabs = tab.owner
        if tabs.shownAt != nil && tab.id == tabs.active { return }
        let saved = UserDefaults.standard.stringArray(forKey: TABS_KEY + tabs.bot)
        close(tabs, tab.id)
        if tabs.open.isEmpty, let saved { UserDefaults.standard.set(saved, forKey: TABS_KEY + tabs.bot) }
    }

    @MainActor private func freeze(_ tab: BrowserTab) {
        guard tab.owner.tab(tab.id) === tab else { return }
        NSLog("browser.frozen: bot %@ tab %@ was closed", tab.owner.bot, tab.id)
        close(tab.owner, tab.id)
    }

    @MainActor private func select(_ tabs: BotTabs, _ id: String) {
        tabs.active = id
        if let placement = tabs.shownAt, let next = tabs.tab(id) { attach(next, placement, fade: false) }
        announceTabs(tabs)
        tabs.tab(id).map(announce)
    }

    @MainActor private func close(_ tabs: BotTabs, _ id: String) {
        guard let tab = tabs.tab(id) else { return }
        tabs.open.removeAll { $0 === tab }
        tab.close()
        guard id == tabs.active else { return announceTabs(tabs) }
        tabs.active = nil
        guard let last = tabs.open.last else { return announceTabs(tabs) }
        select(tabs, last.id)
    }

    @MainActor private func closeAll(_ tabs: BotTabs) {
        let closing = tabs.open
        tabs.open = []
        closing.forEach { $0.close() }
    }

    @MainActor private func isShown(_ tab: BrowserTab) -> Bool {
        guard let pi = bridge?.webView, let views = pi.superview?.subviews, let at = views.firstIndex(of: tab.view), let front = views.firstIndex(of: pi) else { return false }
        return at > front
    }

    @MainActor private func park(_ tab: BrowserTab) {
        guard let pi = bridge?.webView, let host = pi.superview else { return }
        tab.view.frame = CGRect(origin: .zero, size: tab.owner.size)
        host.insertSubview(tab.view, belowSubview: pi)
        tab.expire(after: IDLE_SECONDS)
    }

    @MainActor private func attach(_ tab: BrowserTab, _ placement: Placement, fade: Bool) {
        guard let pi = bridge?.webView, let host = pi.superview else { return }
        // why: only the bottom corners are rounded, where the sheet's own corners are
        tab.view.layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        tab.view.layer.cornerRadius = placement.radius
        tab.view.layer.masksToBounds = true
        tab.expire(after: nil)
        for other in tab.owner.open where other !== tab && isShown(other) { park(other) }
        tab.view.frame = pi.convert(placement.frame, to: host)
        if isShown(tab) { return }
        tab.view.alpha = fade ? 0 : 1
        host.insertSubview(tab.view, aboveSubview: pi)
        if fade { UIView.animate(withDuration: FADE_SECONDS) { tab.view.alpha = 1 } }
    }

    @MainActor private func snapshot(_ tab: BrowserTab, screenshot: Bool, error: String?) async -> Result<JSObject, Stopped> {
        await tab.awaitLoad()
        return await tab.run(FACTS, as: [String: Any].self).then { facts in
            await tab.page("return await page.state();", as: [String: Any].self).then { state in
                let text = (tab.takeNotes() + [facts["text"] as? String ?? ""]).joined(separator: "\n")
                let elements = ["header", "content", "footer"].map { state[$0] as? String ?? "" }.joined(separator: "\n")
                var page: JSObject = ["tab": tab.id, "loading": tab.view.isLoading || facts["ready"] as? String != "complete", "elements": elements, "tabs": listing(tab.owner)["tabs"] ?? [], "text": text]
                if screenshot, let jpeg = await tab.capture() { page["jpeg"] = jpeg }
                if let error { page["error"] = error }
                return .success(page)
            }
        }
    }
}
