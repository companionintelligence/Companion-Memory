// ci-apple-bridge: a tiny resident CLI wrapping Apple's on-device
// FoundationModels framework (Apple Intelligence), spoken to over a
// line-delimited JSON protocol on stdin/stdout — no networking in this
// binary at all. apple_bridge.rs owns the actual HTTP (OpenAI-compatible)
// surface and the cumulative-snapshot-to-delta diffing; this process only
// ever forwards FoundationModels' own (verified empirically: cumulative, not
// incremental — see apple_bridge.rs's module doc) snapshots as-is.
//
// Deliberately out of scope for this first pass: intent/tool-calling (the
// mobile on-device clients' CompanionIntentTools equivalent) and native
// multi-turn Transcript replay — prior turns are flattened into the prompt
// text instead of using LanguageModelSession's Transcript.Entry API, which
// is a coarser but verifiably-working substitute. Both are natural
// follow-ups once this ships.
//
// Protocol (one JSON object per line, in both directions):
//   -> {"id": "...", "instructions": "...", "messages": [{"role", "content"}], "stream": bool}
//   <- {"id": "...", "text": "<cumulative text so far>", "done": false}   (stream only, zero or more)
//   <- {"id": "...", "text": "<final text>", "done": true}                (always exactly one, on success)
//   <- {"id": "...", "error": "<message>", "done": true}                  (instead of the above, on failure)

import FoundationModels
import Foundation

struct BridgeMessage: Decodable {
    let role: String
    let content: String
}

struct BridgeRequest: Decodable {
    let id: String
    let instructions: String?
    let messages: [BridgeMessage]
    let stream: Bool
}

struct BridgeChunk: Encodable {
    let id: String
    var text: String? = nil
    var error: String? = nil
    let done: Bool
}

enum BridgeError: Error, CustomStringConvertible {
    case unavailable(String)

    var description: String {
        switch self {
        case .unavailable(let reason):
            return "on-device model unavailable: \(reason)"
        }
    }
}

/// Renders every message except the last as plain transcript text (the
/// coarser Transcript.Entry substitute noted above) and returns the last
/// user turn separately, since `respond(to:)`/`streamResponse(to:)` take a
/// single prompt string.
func renderPrompt(_ messages: [BridgeMessage]) -> String {
    guard let last = messages.last else { return "" }
    let priorTurns = messages.dropLast()
    guard !priorTurns.isEmpty else { return last.content }

    let history = priorTurns
        .map { turn in "\(turn.role == "assistant" ? "Assistant" : "User"): \(turn.content)" }
        .joined(separator: "\n\n")

    return "\(history)\n\nUser: \(last.content)"
}

func checkAvailability() throws {
    guard case .available = SystemLanguageModel.default.availability else {
        throw BridgeError.unavailable(String(describing: SystemLanguageModel.default.availability))
    }
}

func writeChunk(_ chunk: BridgeChunk) {
    guard let data = try? JSONEncoder().encode(chunk), let line = String(data: data, encoding: .utf8) else {
        return
    }
    print(line)
    fflush(stdout)
}

func handle(_ request: BridgeRequest) async {
    do {
        try checkAvailability()

        let session = LanguageModelSession(instructions: request.instructions)
        let prompt = renderPrompt(request.messages)

        if request.stream {
            let stream = session.streamResponse(to: prompt)
            var finalText = ""
            for try await partial in stream {
                finalText = partial.content
                writeChunk(BridgeChunk(id: request.id, text: finalText, done: false))
            }
            writeChunk(BridgeChunk(id: request.id, text: finalText, done: true))
        } else {
            let response = try await session.respond(to: prompt)
            writeChunk(BridgeChunk(id: request.id, text: response.content, done: true))
        }
    } catch {
        writeChunk(BridgeChunk(id: request.id, error: String(describing: error), done: true))
    }
}

// One `check` line on startup lets the Rust side confirm availability before
// ever spawning this as a long-lived sidecar (see apple_bridge.rs::is_available).
if CommandLine.arguments.contains("--check") {
    do {
        try checkAvailability()
        print("available")
    } catch {
        print("unavailable: \(error)")
    }
    exit(0)
}

let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
    guard let request = try? decoder.decode(BridgeRequest.self, from: data) else {
        FileHandle.standardError.write("ci-apple-bridge: failed to decode request line\n".data(using: .utf8)!)
        continue
    }
    await handle(request)
}
