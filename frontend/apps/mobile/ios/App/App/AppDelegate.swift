import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Seals any credential written by a previous version (or a previous session) to
        // this device, so it cannot ride along in an encrypted backup and restore onto
        // different hardware. See KeychainHardening for why this is a sweep.
        KeychainHardening.hardenStoredCredentials()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    // ⚠️ The four lifecycle methods below, and the two URL handlers at the end of this
    // file, are NOT CALLED in this app. `Info.plist` declares
    // `UIApplicationSceneManifest`, and once scenes are adopted UIKit routes all of it to
    // the UIWindowSceneDelegate instead — see SceneDelegate, which is where the real
    // background hook and the real `companion://` OIDC forwarding live. They are kept
    // because they are the Capacitor template's shape and removing them invites someone to
    // "restore" them later; treat them as documentation, and put nothing load-bearing here.

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Superseded by SceneDelegate.sceneDidEnterBackground — see the note above.
        // KeychainHardening's periodic sweep is called from there, not here.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
