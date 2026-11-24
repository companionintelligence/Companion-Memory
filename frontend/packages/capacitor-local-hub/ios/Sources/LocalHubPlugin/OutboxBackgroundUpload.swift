import Foundation
import UIKit

// UNCOMPILED as written (2026-10-30). See OutboxUpload.swift and the README.

extension OutboxStore: UploadOutbox {}

/// The person's choice in Settings -> Location ("Upload in the background"), kept natively because
/// the upload runs with no WebView. On unless they turned it off.
enum BackgroundUploadSettings {
    private static let enabledKey = "ci.localhub.backgroundUpload.enabled"
    private static let finishOwedKey = "ci.localhub.backgroundUpload.finishOwed"

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    final class FinishDebt: IngestFinishDebt {
        var isOwed: Bool {
            get { UserDefaults.standard.bool(forKey: BackgroundUploadSettings.finishOwedKey) }
            set { UserDefaults.standard.set(newValue, forKey: BackgroundUploadSettings.finishOwedKey) }
        }
    }
}

/// `POST` with the API key over URLSession, the stack the app's own native requests use.
final class URLSessionUploadTransport: UploadTransport {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func postJSON(url: String, apiKey: String, body: String) async -> UploadResponse {
        guard let target = URL(string: url) else {
            return UploadResponse(status: nil, error: "bad URL \(url)")
        }
        // `FLUSH_TIMEOUT_MS` in `outboxFlush.ts`.
        var request = URLRequest(url: target, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // `apiAuth.ts`: the phone authenticates with the long-lived key.
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        do {
            let (_, response) = try await session.data(for: request)
            return UploadResponse(status: (response as? HTTPURLResponse)?.statusCode, error: nil)
        } catch {
            return UploadResponse(status: nil, error: error.localizedDescription)
        }
    }
}

/// Uploads queued location fixes while the app is not on screen, so a trip reaches the appliance
/// without the person opening the app first.
///
/// When: right after the tracker queues a fix. In Always mode iOS relaunches the app in the
/// background for each significant change and gives it a few seconds; this asks for more with
/// `beginBackgroundTask` and spends them uploading. Significant changes are minutes apart, so
/// there is nothing to batch. The background refresh task (`ReplicaBackgroundSync`) also runs one
/// upload each time, which catches fixes left behind when the network was down at the time.
///
/// Where to and as whom: the origin is the `apiBaseUrl` the web side passes when it arms Always
/// (kept in the tracking config); the key is `ci.apiKey` from `CompanionSecureStore`, readable
/// after the first unlock. Without either -- Always off, signed out, a config saved before the
/// field existed -- a run does nothing and the next app open uploads as before.
public enum OutboxBackgroundUpload {
    /// `API_KEY_STORAGE` in the web app's `useAuth.ts`.
    private static let apiKey = "ci.apiKey"
    private static let lock = NSLock()
    private static var running = false
    private static var again = false

    /// Fixes are waiting: upload them now, in background time, if the person allows it. A call
    /// while a run is going makes that run go round once more rather than starting a second.
    static func requestUpload() {
        guard BackgroundUploadSettings.isEnabled else { return }
        lock.lock()
        if running {
            again = true
            lock.unlock()
            return
        }
        running = true
        lock.unlock()

        DispatchQueue.main.async {
            let token = BackgroundTaskToken()
            token.id = UIApplication.shared.beginBackgroundTask(withName: "ci-outbox-upload") {
                // Out of time: what was not sent stays queued for the next run or app open.
                token.end()
            }
            Task.detached(priority: .utility) {
                while true {
                    lock.lock()
                    again = false
                    lock.unlock()
                    _ = await runOnce()
                    lock.lock()
                    let goAgain = again
                    if !goAgain {
                        running = false
                    }
                    lock.unlock()
                    if !goAgain {
                        break
                    }
                }
                await MainActor.run { token.end() }
            }
        }
    }

    /// The `beginBackgroundTask` identifier, ended exactly once, always on the main thread.
    private final class BackgroundTaskToken {
        var id = UIBackgroundTaskIdentifier.invalid

        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }

    /// One upload; true when it finished (sent everything, or had nothing to do).
    static func runOnce() async -> Bool {
        // LocationTracking lives on the main thread.
        let origin = await MainActor.run { LocationTracking.shared.apiBaseUrl }
        guard BackgroundUploadSettings.isEnabled, let origin = origin, !origin.isEmpty else {
            return true
        }
        do {
            guard let key = try CompanionSecureStore.credentials().get(apiKey), !key.isEmpty else { return true }
            let outcome = try await OutboxUploader(
                outbox: try OutboxStore.shared(),
                transport: URLSessionUploadTransport(),
                finishDebt: BackgroundUploadSettings.FinishDebt(),
                kind: PositionRecordJson.outboxKind
            ).drain(origin: origin, apiKey: key)
            switch outcome {
            case .done(let sent):
                if sent > 0 { NSLog("[OutboxUpload] uploaded \(sent) queued fixes") }
                return true
            case .retryLater(let sent, let reason):
                NSLog("[OutboxUpload] uploaded \(sent), the rest later: \(reason)")
                return false
            }
        } catch {
            // Keystore or database not usable yet (before the first unlock after a boot).
            NSLog("[OutboxUpload] run ended: \(error)")
            return false
        }
    }
}
