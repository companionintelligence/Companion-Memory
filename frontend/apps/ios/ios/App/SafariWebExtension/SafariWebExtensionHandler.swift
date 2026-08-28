import os.log
import SafariServices

/// Native message bridge for the bundled Safari Web Extension.
///
/// v1 login still happens inside the extension (Portal OIDC). This handler
/// exists so `browser.runtime.sendNativeMessage` has a principal class; a later
/// App Group can answer with the Memory API key from here.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]
        os_log(.default, "Safari Web Extension message: %{public}@", String(describing: message))

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
