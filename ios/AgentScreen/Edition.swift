import Capacitor
import Foundation
import WebKit

@objc(PiEdition)
final class PiEdition: NSObject, EditionPlugins {
    static func plugins() -> [CAPPlugin] { [PhoneScreenPlugin()] }
    static func backgroundRunner(_ configuration: WKWebViewConfiguration) -> BackgroundRunner { BackgroundPage(configuring: configuration) }
}
