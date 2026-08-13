import UIKit
import Capacitor

// iOS 26 (Xcode 26+ SDK) requires UIScene lifecycle adoption — a real
// UIWindowSceneDelegate. Capacitor's default template still uses the legacy
// AppDelegate-window model, which now traps at launch. This delegate creates the
// window from the Main storyboard (the Capacitor bridge view controller) and
// attaches it to the window scene.
//
// **Adopting scenes silently retires a set of UIApplicationDelegate callbacks.** Once
// `UIApplicationSceneManifest` is present in Info.plist, UIKit stops calling
// `application(_:open:options:)`, `application(_:continue:restorationHandler:)`,
// `applicationDidEnterBackground(_:)` and friends — the scene equivalents below are
// called instead. Capacitor has no scene support of its own (`ApplicationDelegateProxy`
// is a plain `UIApplicationDelegate`), so anything the AppDelegate used to forward has to
// be forwarded from here or it is simply dropped. That cost two live features before this
// file forwarded them:
//
//   • The OIDC callback. "Sign in with CI Portal" returns through the `companion://`
//     custom scheme; with no `scene(_:openURLContexts:)` the URL never reached
//     `ApplicationDelegateProxy`, so `@capacitor/app` never raised `appUrlOpen`, so
//     `useAuth`'s listener never fired and sign-in could never complete.
//   • `KeychainHardening`'s background sweep, which `AppDelegate` calls from
//     `applicationDidEnterBackground` — a method UIKit no longer invokes.
//
// Routing through `ApplicationDelegateProxy.shared` (rather than posting the
// notifications directly) is deliberate: it also sets `lastURL`, which is what
// `@capacitor/app`'s `getLaunchUrl` reads, and the plugin posts `appUrlOpen` with
// `retainUntilConsumed: true` — so a URL that arrives during a cold launch, before the web
// layer has attached its listener, is still delivered rather than lost.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        window.makeKeyAndVisible()

        // A cold launch *caused by* the URL delivers it here, not through
        // scene(_:openURLContexts:) — handling only the latter loses exactly the case
        // where the user was sent to Portal, the app was evicted, and the callback
        // relaunches it.
        if let urlContext = connectionOptions.urlContexts.first {
            handle(urlContext)
        }
        for activity in connectionOptions.userActivities
        where activity.activityType == NSUserActivityTypeBrowsingWeb {
            handle(activity)
        }
    }

    /// Warm deep link — the app was already running when Portal bounced back.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        handle(urlContext)
    }

    /// Universal Links.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        handle(userActivity)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // The scene-lifecycle counterpart of AppDelegate.applicationDidEnterBackground,
        // which UIKit does not call once scenes are adopted. Seals any credential the web
        // layer stored during this session before the app goes idle — see KeychainHardening.
        KeychainHardening.hardenStoredCredentials()
    }

    // MARK: - Forwarding

    private func handle(_ urlContext: UIOpenURLContext) {
        // Rebuild the options dictionary the UIApplicationDelegate API would have carried.
        // Both entries are genuinely optional, so they are added only when present rather
        // than stored as NSNull, which is what a bare `as Any` would produce.
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        if let sourceApplication = urlContext.options.sourceApplication {
            options[.sourceApplication] = sourceApplication
        }
        if let annotation = urlContext.options.annotation {
            options[.annotation] = annotation
        }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: urlContext.url,
            options: options
        )
    }

    private func handle(_ userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
