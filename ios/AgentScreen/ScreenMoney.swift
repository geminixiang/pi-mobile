import Capacitor
import Foundation

private let shownCharacters = 60
private let currencyCodes = Set(Locale.commonISOCurrencyCodes)
private let gaps: Set<Unicode.Scalar> = [" ", "\u{00A0}", "\u{202F}"]

enum Held {
    case money(String)
    case secret

    var json: JSObject {
        switch self {
        case .money(let shown): return ["kind": "money", "shown": shown]
        case .secret: return ["kind": "secret"]
        }
    }
}

func handsOn(_ action: String, key: String?) -> Bool {
    ["tap", "long_press", "swipe", "type", "clear"].contains(action) || (action == "key" && key == "enter")
}

extension ScreenView {
    func held(for action: String) -> Held? {
        if ["type", "clear"].contains(action) && secretFocused { return .secret }
        guard let shown = lines.map(\.label).first(where: showsAmount) else { return nil }
        return .money(String(shown.trimmingCharacters(in: .whitespacesAndNewlines).prefix(shownCharacters)))
    }
}

private func showsAmount(_ text: String) -> Bool {
    let scalars = Array(text.unicodeScalars)
    let symbol = scalars.indices.contains { scalars[$0].properties.generalCategory == .currencySymbol && digitBeside(scalars, $0, $0 + 1) }
    return symbol || codeRuns(scalars).contains { currencyCodes.contains(String(String.UnicodeScalarView(scalars[$0]))) && digitBeside(scalars, $0.lowerBound, $0.upperBound) }
}

private func codeRuns(_ scalars: [Unicode.Scalar]) -> [Range<Int>] {
    var runs: [Range<Int>] = []
    var start: Int?
    for index in 0...scalars.count {
        let letter = index < scalars.count && scalars[index].isASCII && scalars[index].properties.isAlphabetic
        if letter, start == nil { start = index }
        if !letter, let begin = start {
            if index - begin == 3 && scalars[begin..<index].allSatisfy({ $0.properties.isUppercase }) { runs.append(begin..<index) }
            start = nil
        }
    }
    return runs
}

private func digitBeside(_ scalars: [Unicode.Scalar], _ start: Int, _ end: Int) -> Bool {
    func at(_ index: Int) -> Unicode.Scalar? { scalars.indices.contains(index) ? scalars[index] : nil }
    let after = at(end).flatMap { gaps.contains($0) ? at(end + 1) : $0 }
    let before = at(start - 1).flatMap { gaps.contains($0) ? at(start - 2) : $0 }
    return [after, before].contains { $0?.properties.numericType != nil }
}
