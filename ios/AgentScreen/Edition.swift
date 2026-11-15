import Capacitor
import Foundation

@objc(PiEdition)
final class PiEdition: NSObject, EditionPlugins {
    static func plugins() -> [CAPPlugin] { [PhoneScreenPlugin()] }
}
