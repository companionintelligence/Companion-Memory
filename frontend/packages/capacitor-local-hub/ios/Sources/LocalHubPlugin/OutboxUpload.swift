import Foundation

// Background upload of queued location fixes, iOS half; the Android twin is
// `android/.../localhub/upload/`. Keep the two in step. This file is Foundation-only (it is
// type-checked and exercised on Linux with a harness porting the Android tests); the iOS wiring
// is in OutboxBackgroundUpload.swift. UNCOMPILED by Xcode as written (2026-10-30).

// MARK: - Owner stamp

/// `outboxOwnerStamp()` from `@ci/common`'s `outbox.ts`, ported: the appliance origin plus a
/// fingerprint of the API key, which every queued row is stamped with at enqueue. A row is sent
/// only when its stamp equals this value for the key and origin it is about to go out with -- the
/// rule the web flusher applies -- so a fix queued under one account never goes out under another's
/// key. Must agree bit for bit with the TypeScript; the harness pins fixtures computed by it.
enum OutboxOwnerStamp {
    static func of(origin: String, apiKey: String) -> String {
        "\(origin.isEmpty ? "same-origin" : origin) \(fingerprint("\(origin)\n\(apiKey)"))"
    }

    /// cyrb53 over UTF-16 code units, as JavaScript's `charCodeAt` sees the string. `&*` on
    /// `UInt32` keeps the low 32 bits exactly as `Math.imul` does, and `>>` on `UInt32` is `>>>`.
    static func fingerprint(_ value: String) -> String {
        var h1: UInt32 = 0xdeadbeef
        var h2: UInt32 = 0x41c6ce57
        for unit in value.utf16 {
            let code = UInt32(unit)
            h1 = (h1 ^ code) &* 2_654_435_761
            h2 = (h2 ^ code) &* 1_597_334_677
        }
        h1 = (h1 ^ (h1 >> 16)) &* 2_246_822_507
        h1 ^= (h2 ^ (h2 >> 13)) &* 3_266_489_909
        h2 = (h2 ^ (h2 >> 16)) &* 2_246_822_507
        h2 ^= (h1 ^ (h1 >> 13)) &* 3_266_489_909
        let combined = (UInt64(h2 & 0x1f_ffff) << 32) + UInt64(h1)
        let hex = String(combined, radix: 16)
        return String(repeating: "0", count: max(0, 14 - hex.count)) + hex
    }
}

// MARK: - Uploader

/// The outbox as the uploader needs it; `OutboxStore` conforms (OutboxBackgroundUpload.swift).
protocol UploadOutbox: AnyObject {
    func list(status: String?) throws -> [OutboxItem]
    func item(id: String) throws -> OutboxItem?
    func delete(id: String) throws -> Bool
    func recordFailedAttempt(id: String, error: String, permanent: Bool) throws -> OutboxItem?
}

/// One HTTP exchange with the appliance. `status` is nil when no response arrived at all.
struct UploadResponse: Equatable {
    let status: Int?
    let error: String?

    var ok: Bool { status.map { (200...299).contains($0) } ?? false }
}

protocol UploadTransport {
    func postJSON(url: String, apiKey: String, body: String) async -> UploadResponse
}

/// Whether the appliance still owes processing for rows that were uploaded. Persisted, because
/// the process that uploaded them can be suspended before the finish call goes out.
protocol IngestFinishDebt: AnyObject {
    var isOwed: Bool { get set }
}

/// Sends the positions waiting in the outbox to the appliance without the app being open. The
/// same contract as the web flusher (`flushOutbox` in `@ci/common`'s `outboxFlush.ts`), narrowed
/// to the one kind native code produces: only rows stamped for the session being sent under; a
/// row leaves the queue only after the appliance accepted it; a 4xx waiting cannot fix parks it in
/// `needs_attention`; anything transient ends the run without spending the row's attempts (a phone
/// is often out of reach of its appliance); then `POST /api/v1/ingest/finish`, because
/// `/api/v1/positions` stores rows unprocessed and leaves asking for that to the client.
final class OutboxUploader {
    enum Outcome: Equatable {
        /// Everything sendable went out (possibly nothing), and no processing is owed.
        case done(sent: Int)
        /// The appliance could not be reached or was unwell; try again later.
        case retryLater(sent: Int, reason: String)
    }

    static let positionsPath = "/api/v1/positions"
    static let ingestFinishPath = "/api/v1/ingest/finish"
    /// `POSITION_FINISH_STAGES` in `outboxFlush.ts`, in the appliance's canonical order.
    static let finishStages = ["reverse_position", "estimate_locations"]
    /// `RETRYABLE_CLIENT_STATUSES` in `outboxFlush.ts`; 409 added for a finish already running.
    private static let retryableClientStatuses: Set<Int> = [401, 403, 408, 409, 425, 429]
    private static let maxPasses = 20

    private let outbox: UploadOutbox
    private let transport: UploadTransport
    private let finishDebt: IngestFinishDebt
    private let kind: String

    init(outbox: UploadOutbox, transport: UploadTransport, finishDebt: IngestFinishDebt, kind: String = "positions") {
        self.outbox = outbox
        self.transport = transport
        self.finishDebt = finishDebt
        self.kind = kind
    }

    /// A 4xx outside the retryable set; no response at all is transient.
    static func isPermanent(_ status: Int?) -> Bool {
        guard let status = status else { return false }
        return (400...499).contains(status) && !retryableClientStatuses.contains(status)
    }

    func drain(origin: String, apiKey: String) async throws -> Outcome {
        var base = origin
        while base.hasSuffix("/") {
            base.removeLast()
        }
        let stamp = OutboxOwnerStamp.of(origin: base, apiKey: apiKey)
        var sent = 0

        // Re-listed until a pass finds nothing: the tracker can queue fixes while this runs. Each
        // pass removes or parks every row it saw, so the loop ends; the cap is a backstop.
        for _ in 0..<Self.maxPasses {
            let batch = try outbox.list(status: "pending")
                .filter { $0.kind == kind && $0.owner == stamp }
                .sorted { $0.seq < $1.seq }
            if batch.isEmpty {
                break
            }
            for row in batch {
                guard let payload = try outbox.item(id: row.id)?.payload else { continue }
                let response = await transport.postJSON(url: base + Self.positionsPath, apiKey: apiKey, body: payload)
                if response.ok {
                    // Debt first, so it survives being suspended between the two writes.
                    finishDebt.isOwed = true
                    _ = try outbox.delete(id: row.id)
                    sent += 1
                } else if Self.isPermanent(response.status) {
                    _ = try outbox.recordFailedAttempt(id: row.id, error: Self.describe(response), permanent: true)
                } else {
                    return .retryLater(sent: sent, reason: Self.describe(response))
                }
            }
        }

        if finishDebt.isOwed {
            let body = String(
                data: try JSONSerialization.data(withJSONObject: ["stages": Self.finishStages]),
                encoding: .utf8
            ) ?? "{}"
            let response = await transport.postJSON(url: base + Self.ingestFinishPath, apiKey: apiKey, body: body)
            if response.ok || Self.isPermanent(response.status) {
                // A permanent refusal will not change by asking again; the rows are stored either way.
                finishDebt.isOwed = false
            } else {
                return .retryLater(sent: sent, reason: "ingest finish: \(Self.describe(response))")
            }
        }
        return .done(sent: sent)
    }

    private static func describe(_ response: UploadResponse) -> String {
        response.error ?? "HTTP \(response.status.map(String.init) ?? "?")"
    }
}
