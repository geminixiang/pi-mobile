@preconcurrency import Capacitor
import Foundation

private let SETTLE_SECONDS = 0.4
private let WAIT_FOR_POLL_SECONDS = 0.25
private let NO_FOCUS = Stopped("no field has focus: tap the field first")
private let CENTER = """
const center = await page.center(index);
const seen = window.visualViewport;
return { x: (center.x / devicePixelRatio - seen.offsetLeft) * seen.scale, y: (center.y / devicePixelRatio - seen.offsetTop) * seen.scale, what: center.what };
"""
private let CLICK_AT = "const seen = window.visualViewport; page.clickAt(x / seen.scale + seen.offsetLeft, y / seen.scale + seen.offsetTop);"
private let INSERT = "const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('insertText', false, text); return 'ok';"
private let CLEAR = "const e = document.activeElement; if (!e || e === document.body) return 'nofocus'; document.execCommand('selectAll'); document.execCommand('delete'); return 'ok';"
private let HAS_TEXT = "return (document.body ? document.body.innerText : '').includes(text);"
// why: iOS gives an app no way to send a key to a web view, and a key event made by script has no effect of its own, so what the key does is done here
private let PRESS = """
const target = document.activeElement || document.body;
const fire = (type) => target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true, view: window }));
const acted = fire('keydown') && (key !== 'Enter' || fire('keypress'));
if (acted && key === 'Backspace') document.execCommand('delete');
if (acted && key === 'Tab') {
    const stops = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex], [contenteditable]')].filter((stop) => !stop.disabled && stop.tabIndex >= 0 && stop.type !== 'hidden' && stop.getClientRects().length > 0);
    stops[(stops.indexOf(target) + 1) % stops.length]?.focus();
}
if (acted && key === 'Enter') {
    if (target.isContentEditable) document.execCommand('insertParagraph');
    else if (target instanceof HTMLTextAreaElement) document.execCommand('insertLineBreak');
    else if (target instanceof HTMLInputElement && target.form) {
        const submit = [...target.form.elements].find((control) => control.type === 'submit');
        if (!submit) target.form.requestSubmit();
        else if (!submit.disabled) submit.click();
    } else if (target.matches('a[href], button, summary')) target.click();
}
fire('keyup');
"""

struct Key {
    let name: String
    let code: Int

    static func of(_ key: String) -> Key? {
        switch key {
        case "enter": return Key(name: "Enter", code: 13)
        case "tab": return Key(name: "Tab", code: 9)
        case "escape": return Key(name: "Escape", code: 27)
        case "backspace": return Key(name: "Backspace", code: 8)
        default: return nil
        }
    }
}

enum Step {
    case open(String)
    case tap(Int)
    case tapAt(CGPoint)
    case type(Int, String)
    case typeHere(String)
    case clear
    case select(Int, String)
    case press(Key)
    case scroll(String, Int?)
    case back
    case forward
    case reload
    case wait(Double)
    case waitFor(String, gone: Bool, seconds: Double)

    static func of(_ json: JSObject) -> Step? {
        let action = json["action"] as? String
        let index = json["index"] as? Int
        let text = json["text"] as? String
        let direction = json["direction"] as? String
        let seconds = (json["ms"] as? Double).map { $0 / 1000 }
        switch action {
        case "open": return (json["url"] as? String).map(Step.open)
        case "tap": return index.map(Step.tap)
        case "tap_at":
            guard let x = json["x"] as? Double, let y = json["y"] as? Double else { return nil }
            return .tapAt(CGPoint(x: x, y: y))
        case "type":
            guard let index, let text else { return nil }
            return .type(index, text)
        case "type_here": return text.map(Step.typeHere)
        case "clear": return .clear
        case "select":
            guard let index, let option = json["option"] as? String else { return nil }
            return .select(index, option)
        case "key": return (json["key"] as? String).flatMap(Key.of).map(Step.press)
        case "scroll": return direction.map { .scroll($0, nil) }
        case "scroll_in":
            guard let index, let direction else { return nil }
            return .scroll(direction, index)
        case "back": return .back
        case "forward": return .forward
        case "reload": return .reload
        case "wait": return seconds.map(Step.wait)
        case "wait_for":
            guard let text, let gone = json["gone"] as? Bool, let seconds else { return nil }
            return .waitFor(text, gone: gone, seconds: seconds)
        default: return nil
        }
    }
}

extension BrowserTab {
    func perform(_ step: Step) async -> Result<String?, Stopped> {
        switch step {
        case .open(let address):
            return await open(address).then { await settle() }
        case .reload:
            view.reload()
            return await settle()
        case .tap(let index):
            return await tapElement(index).then { target in await settle().map { _ in "tapped \(target)" } }
        case .tapAt(let point):
            return await tapPoint(point).then { await settle() }
        case .type(let index, let text):
            return await center(index)
                .then { target in await page("page.click(index);", ["index": index], as: Any.self).map { _ in target.what } }
                .then { what in
                    await pause(SETTLE_SECONDS)
                    return await insert(text).map { "typed into [\(index)] \(what)" }
                }
        case .typeHere(let text):
            return await insert(text).map { nil }
        case .clear:
            return await focused(CLEAR)
        case .select(let index, let option):
            return await paged("await page.select(index, option);", ["index": index, "option": option])
        case .press(let key):
            return await run(PRESS, ["key": key.name, "code": key.code], as: Any.self).then { _ in await settle() }
        case .scroll(let direction, let index):
            return await paged("await page.scroll(direction, index ?? undefined);", ["direction": direction, "index": index ?? NSNull()])
        case .back:
            guard view.canGoBack else { return .failure(Stopped("there is no page to go back to")) }
            view.goBack()
            return await settle()
        case .forward:
            guard view.canGoForward else { return .failure(Stopped("there is no page to go forward to")) }
            view.goForward()
            return await settle()
        case .wait(let seconds):
            await pause(seconds)
            return .success(nil)
        case .waitFor(let text, let gone, let seconds):
            return await waitFor(text, gone: gone, seconds: seconds)
        }
    }

    private func settle() async -> Result<String?, Stopped> {
        await pause(SETTLE_SECONDS)
        await awaitLoad()
        await pause(SETTLE_SECONDS)
        return .success(nil)
    }

    private func paged(_ script: String, _ arguments: [String: Any]) async -> Result<String?, Stopped> {
        await page(script, arguments, as: Any.self).then { _ in
            await pause(SETTLE_SECONDS)
            return .success(nil)
        }
    }

    private func center(_ index: Int) async -> Result<(point: CGPoint, what: String), Stopped> {
        await page(CENTER, ["index": index], as: [String: Any].self).then { center in
            guard let x = center["x"] as? Double, let y = center["y"] as? Double else { return .failure(Stopped("[\(index)] has no place on the page; read the page again")) }
            return .success((CGPoint(x: x, y: y), center["what"] as? String ?? ""))
        }
    }

    private func tapElement(_ index: Int) async -> Result<String, Stopped> {
        await center(index).then { target in
            switch await realTap(at: target.point) {
            case .delivered: return .success("[\(index)] \(target.what)")
            case .unconfirmed(let reason): return .failure(Stopped(reason))
            case .unavailable: return await page("page.click(index);", ["index": index], as: Any.self).map { _ in "[\(index)] \(target.what)" }
            }
        }
    }

    private func tapPoint(_ point: CGPoint) async -> Result<Void, Stopped> {
        switch await realTap(at: point) {
        case .delivered: return .success(())
        case .unconfirmed(let reason): return .failure(Stopped(reason))
        case .unavailable: return await page(CLICK_AT, ["x": point.x, "y": point.y], as: Any.self).map { _ in }
        }
    }

    private func insert(_ text: String) async -> Result<Void, Stopped> {
        await focused(INSERT, ["text": text]).map { _ in }
    }

    private func focused(_ script: String, _ arguments: [String: Any] = [:]) async -> Result<String?, Stopped> {
        await run(script, arguments, as: String.self).flatMap { $0 == "ok" ? .success(nil) : .failure(NO_FOCUS) }
    }

    private func waitFor(_ text: String, gone: Bool, seconds: Double) async -> Result<String?, Stopped> {
        let end = ProcessInfo.processInfo.systemUptime + seconds
        while true {
            switch await run(HAS_TEXT, ["text": text], as: Bool.self) {
            case .failure(let stop): return .failure(stop)
            case .success(let there):
                if there != gone { return .success(nil) }
                if ProcessInfo.processInfo.systemUptime >= end { return .failure(Stopped("waited \(Int(seconds)) s and \"\(text)\" \(gone ? "is still on the page" : "did not appear")")) }
                await pause(WAIT_FOR_POLL_SECONDS)
            }
        }
    }
}
