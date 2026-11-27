import UIKit
import Capacitor

/// App-local Capacitor plugin `NocturneShare` (JS: platform/instagramStory.ts).
/// `shareToInstagramStory({ imageBase64, appId, topColor, bottomColor })` puts the sticker PNG and the two
/// background colours on the pasteboard (5 min expiry, local only) and opens `instagram-stories://share`.
/// Resolves `{ opened, installed }`; `installed: false` makes the JS side fall back to the share sheet.
/// https://developers.facebook.com/docs/instagram-platform/sharing-to-stories/
@objc(NocturneSharePlugin)
public class NocturneSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NocturneSharePlugin"
    public let jsName = "NocturneShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "shareToInstagramStory", returnType: CAPPluginReturnPromise)
    ]

    static let scheme = "instagram-stories"
    static let stickerKey = "com.instagram.sharedSticker.stickerImage"
    static let topKey = "com.instagram.sharedSticker.backgroundTopColor"
    static let bottomKey = "com.instagram.sharedSticker.backgroundBottomColor"
    static let maxBytes = 4 * 1024 * 1024

    static func isHexColor(_ s: String?) -> Bool {
        guard let s = s, s.count == 7, s.hasPrefix("#") else { return false }
        return s.dropFirst().allSatisfy { $0.isHexDigit }
    }

    static func isAppId(_ s: String?) -> Bool {
        guard let s = s else { return false }
        return (5...25).contains(s.count) && s.allSatisfy { $0.isASCII && $0.isNumber }
    }

    @objc func shareToInstagramStory(_ call: CAPPluginCall) {
        guard let appId = call.getString("appId")?.trimmingCharacters(in: .whitespaces), NocturneSharePlugin.isAppId(appId),
              let b64 = call.getString("imageBase64"),
              let png = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              !png.isEmpty, png.count <= NocturneSharePlugin.maxBytes else {
            call.reject("invalid arguments")
            return
        }
        let top = NocturneSharePlugin.isHexColor(call.getString("topColor")) ? call.getString("topColor")!.lowercased() : "#1c2433"
        let bottom = NocturneSharePlugin.isHexColor(call.getString("bottomColor")) ? call.getString("bottomColor")!.lowercased() : "#080b12"

        DispatchQueue.main.async {
            guard let url = URL(string: "\(NocturneSharePlugin.scheme)://share?source_application=\(appId)"),
                  UIApplication.shared.canOpenURL(url) else {
                call.resolve(["opened": false, "installed": false])
                return
            }
            let items: [[String: Any]] = [[
                NocturneSharePlugin.stickerKey: png,
                NocturneSharePlugin.topKey: top,
                NocturneSharePlugin.bottomKey: bottom
            ]]
            UIPasteboard.general.setItems(items, options: [.expirationDate: Date().addingTimeInterval(300)])
            UIApplication.shared.open(url, options: [:]) { ok in
                call.resolve(["opened": ok, "installed": true])
            }
        }
    }
}

/// Main view controller: Capacitor only auto-registers npm plugins, so the app-local one is added here.
class NocturneViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NocturneSharePlugin())
    }
}
