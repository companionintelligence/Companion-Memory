import Capacitor

// The root view controller `Main.storyboard` instantiates (`SceneDelegate` asks the storyboard for it): Capacitor's
// `CAPBridgeViewController`, plus the one thing the stock one cannot do — register the plugins that live in this
// app target rather than in an npm package.
//
// **Why it has to exist.** Capacitor 7 finds a plugin in exactly two ways: the `packageClassList` that `cap sync`
// writes into `capacitor.config.json`, or `bridge.registerPluginInstance(_:)`. The list is built from the `ios/`
// sources of the *installed npm packages* (`@capacitor/cli` `util/iosplugin.js`), so `LocalLLMPlugin` — which lives
// in `LocalLLM/` because `@ci/capacitor-local-llm` is Android-only — is never on it, and Capacitor 7 dropped the
// Objective-C runtime scan that used to find such classes. Left unregistered, the web layer finds no
// `window.Capacitor.Plugins.LocalLLM` and Settings → On-device model reads "On-device models run in the iOS and
// Android apps." on a phone, which also hides every download/load/chat path behind it.
//
// **Why it survives `cap sync`.** Nothing in this file is generated. `cap sync` rewrites `capacitor.config.json`,
// `App/public`, the Podfile and Pods — it never touches this source, the storyboard's `customClass`, or the Xcode
// project's file list. `capacitorPluginContract.test.ts` pins all three, because dropping any one of them still
// compiles and still launches: the plugin just silently stops existing.
//
// **`registerPluginInstance`, not `registerPluginType`:** with the default `autoRegisterPlugins` the latter returns
// at once. `capacitorDidLoad()` runs after the bridge exists and before the web view loads its first page, which is
// when a plugin's JS has to be injected.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocalLLMPlugin())
    }
}
