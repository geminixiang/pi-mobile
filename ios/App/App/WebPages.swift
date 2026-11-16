import CryptoKit
import WebKit

struct Stopped: Error {
    let reason: String

    init(_ reason: String) {
        self.reason = reason
    }
}

extension Result {
    nonisolated(nonsending) func then<Next>(_ next: nonisolated(nonsending) (Success) async -> Result<Next, Failure>) async -> Result<Next, Failure> {
        switch self {
        case .success(let value): return await next(value)
        case .failure(let failure): return .failure(failure)
        }
    }
}

func pause(_ seconds: Double) async {
    await withCheckedContinuation { waiter in
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { waiter.resume() }
    }
}

@MainActor enum WebPages {
    static let pageScript = Bundle.main.url(forResource: "page-controller", withExtension: "js", subdirectory: "public").flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    nonisolated static func isWeb(_ url: URL) -> Bool {
        url.scheme == "http" || url.scheme == "https"
    }

    static func create(profile: String, size: CGSize) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // why: a page on pi's own data store would read pi's cookies and storage; each profile keeps its logins in a store of its own
        configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: storeOf(profile))
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsInlineMediaPlayback = true
        // why: a WKWebView's User-Agent lacks Safari's Version/ and Safari/ tokens, and sites that refuse to sign in to an embedded browser go by that (Android drops "; wv" for the same reason)
        let system = ProcessInfo.processInfo.operatingSystemVersion
        configuration.applicationNameForUserAgent = "Version/\(system.majorVersion).\(system.minorVersion) Mobile/15E148 Safari/604.1"
        let view = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: configuration)
        // why: with safe-area insets on the scroll view a point in the page is no longer that point in the view, and a real touch would land beside its element
        view.scrollView.contentInsetAdjustmentBehavior = .never
        // why: iOS 26 blurs what a scroll view shows under the status bar, where a tab waiting behind pi sits, and the blur ends up in its screenshots
        view.scrollView.topEdgeEffect.isHidden = true
        return view
    }

    static func allows(_ action: WKNavigationAction) -> Bool {
        guard let url = action.request.url else { return false }
        let inner = action.targetFrame.map { !$0.isMainFrame } ?? false
        return inner || isWeb(url) || url.scheme == "about"
    }

    static func certificateProblem(_ failure: NSError) -> String? {
        guard failure.domain == NSURLErrorDomain else { return nil }
        switch failure.code {
        case NSURLErrorServerCertificateHasBadDate: return "has expired"
        case NSURLErrorServerCertificateNotYetValid: return "is not valid yet"
        case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot: return "is not trusted"
        default: return nil
        }
    }

    static func forget(profile: String) async -> Bool {
        let store = storeOf(profile)
        guard await WKWebsiteDataStore.allDataStoreIdentifiers.contains(store) else { return true }
        do {
            try await WKWebsiteDataStore.remove(forIdentifier: store)
            return true
        } catch {
            // why: WebKit refuses while a web view on the store is still going away or has a call running, so the store is emptied now and removed at the next start
            await WKWebsiteDataStore(forIdentifier: store).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            return false
        }
    }

    private static func storeOf(_ profile: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data(profile.utf8)).prefix(16))
        bytes[6] = bytes[6] & 0x0F | 0x50
        bytes[8] = bytes[8] & 0x3F | 0x80
        return UUID(uuid: bytes.withUnsafeBytes { $0.loadUnaligned(as: uuid_t.self) })
    }
}
