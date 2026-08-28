//! Bridges CI-Server's existing OpenAI-compatible `LLM_API_BASE` contract
//! (backend/apps/api/src/domains/llm/services/OpenAiCompatChatDriver.ts) onto
//! Apple's on-device FoundationModels framework, via the standalone
//! `ci-apple-bridge` Swift CLI (../../apple-bridge, compiled by build.rs) —
//! not an FFI static lib, so this crate carries zero unsafe Swift-interop
//! surface. Everything OpenAI-shaped (the HTTP surface, SSE framing, and
//! diffing FoundationModels' cumulative snapshots into deltas) lives here;
//! the Swift process only ever forwards raw model output over stdio.
//!
//! Cumulative, not incremental — verified directly against a real on-device
//! session before writing this (a short "count to 5" prompt's later chunks
//! each repeated the full "1\n2\n3\n4\n5" text, not just a new token):
//! `LanguageModelSession.streamResponse` yields the full text generated so
//! far on every snapshot, so `respond_streaming` below diffs each chunk
//! against the previous one (`text.strip_prefix(previous)`) rather than
//! concatenating deltas.
//!
//! Known v1 limitations, documented rather than silently absent:
//!   - No tool-calling. A request carrying `tools` still gets a plain-text
//!     answer; OllamaService's tool loop just never sees a `tool_calls`
//!     field, so it degrades to "answered without calling a tool" rather
//!     than erroring — the same way any model handed tools it can't invoke
//!     would behave.
//!   - SSE responses are assembled in full before being sent, not delivered
//!     token-by-token over the wire. FoundationModels' on-device generation
//!     is fast enough locally that this is a minor perceived-latency cost,
//!     not a correctness one — the client still receives the same sequence
//!     of `data: {...}` chunks either way. Genuine incremental delivery
//!     would need the streaming response body to own the stdio lock for its
//!     whole lifetime, which is real complexity worth taking on separately.
//!   - One request in flight at a time — `ci_apple_bridge`'s stdio
//!     conversation is a single resident, sequential channel; concurrent HTTP
//!     requests simply queue on the shared `BridgeIo` mutex. Fine for a
//!     single-user local desktop app.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};

/// The only model id this bridge ever serves — CI-Server's model picker and
/// preflight check (OllamaService.getAvailableModels/checkModelAvailable)
/// both go through GET /v1/models, so this id just needs to be stable and
/// appear in that list; it never needs to compare-equal to anything else.
const MODEL_ID: &str = "apple-on-device";

pub struct AppleBridgeHandle {
    pub port: u16,
    child: Child,
}

impl AppleBridgeHandle {
    pub fn shutdown(mut self) {
        let _ = self.child.kill();
    }
}

struct BridgeIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// Runs `<binary> --check` (see apple-bridge/Sources/ci-apple-bridge/main.swift)
/// and looks for its "available" line. False for anything short of that,
/// including the binary being absent — e.g. build.rs skipped it because this
/// wasn't a macOS build, or the build host had no Xcode.
pub fn is_available(bridge_binary: &Path) -> bool {
    if !bridge_binary.is_file() {
        return false;
    }
    Command::new(bridge_binary)
        .arg("--check")
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "available")
        .unwrap_or(false)
}

pub fn spawn(bridge_binary: &Path, log_path: &Path) -> Result<AppleBridgeHandle, String> {
    let port = crate::port_check::find_free_port()
        .ok_or_else(|| "No free port available for the Apple on-device bridge".to_string())?;

    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|e| format!("Failed to open {}: {e}", log_path.display()))?;

    let mut child = Command::new(bridge_binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", bridge_binary.display()))?;

    let stdin = child.stdin.take().ok_or_else(|| "Failed to open bridge stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Failed to open bridge stdout".to_string())?;
    let io = Arc::new(Mutex::new(BridgeIo { stdin, stdout: BufReader::new(stdout) }));

    let server = tiny_http::Server::http(("127.0.0.1", port))
        .map_err(|e| format!("Failed to bind the Apple bridge HTTP shim on port {port}: {e}"))?;
    std::thread::spawn(move || serve_loop(server, io));

    Ok(AppleBridgeHandle { port, child })
}

fn serve_loop(server: tiny_http::Server, io: Arc<Mutex<BridgeIo>>) {
    for request in server.incoming_requests() {
        let io = Arc::clone(&io);
        std::thread::spawn(move || handle_request(request, io));
    }
}

fn handle_request(mut request: tiny_http::Request, io: Arc<Mutex<BridgeIo>>) {
    if request.method() == &tiny_http::Method::Get && request.url().starts_with("/v1/models") {
        let body = json!({
            "object": "list",
            "data": [{ "id": MODEL_ID, "object": "model", "created": 0, "owned_by": "apple" }],
        });
        let _ = request.respond(json_response(200, &body));
        return;
    }

    if !(request.method() == &tiny_http::Method::Post && request.url().starts_with("/v1/chat/completions")) {
        let _ = request.respond(tiny_http::Response::empty(404));
        return;
    }

    let mut body = String::new();
    if let Err(e) = request.as_reader().read_to_string(&mut body) {
        let _ = request.respond(json_response(400, &json!({ "error": format!("failed to read body: {e}") })));
        return;
    }

    let parsed: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            let _ = request.respond(json_response(400, &json!({ "error": format!("invalid JSON: {e}") })));
            return;
        }
    };

    let stream_requested = parsed.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let (instructions, messages) = split_messages(&parsed);
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4());
    let model = parsed.get("model").and_then(Value::as_str).unwrap_or(MODEL_ID).to_string();

    let bridge_request = json!({
        "id": id,
        "instructions": instructions,
        "messages": messages,
        "stream": stream_requested,
    });

    let mut guard = io.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Err(e) = write_request(&mut guard, &bridge_request) {
        drop(guard);
        let _ = request.respond(json_response(502, &json!({ "error": e })));
        return;
    }

    if stream_requested {
        respond_streaming(request, &mut guard, &id, &model);
    } else {
        respond_buffered(request, &mut guard, &id, &model);
    }
}

/// Splits the OpenAI `messages` array into (system instructions, the rest) —
/// `ci-apple-bridge` takes them separately (LanguageModelSession's own
/// instructions/prompt split). `tools`, if present, is deliberately ignored;
/// see the module doc comment.
fn split_messages(parsed: &Value) -> (Option<String>, Vec<Value>) {
    let messages = parsed.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut instructions_parts = Vec::new();
    let mut rest = Vec::new();

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = message.get("content").and_then(Value::as_str).unwrap_or("").to_string();

        if role == "system" {
            instructions_parts.push(content);
        } else {
            // "tool" role messages should never appear here in practice — this
            // bridge never emits tool_calls for a caller to answer — but map
            // them onto "user" defensively rather than dropping content.
            let mapped_role = if role == "assistant" { "assistant" } else { "user" };
            rest.push(json!({ "role": mapped_role, "content": content }));
        }
    }

    let instructions = (!instructions_parts.is_empty()).then(|| instructions_parts.join("\n\n"));
    (instructions, rest)
}

fn write_request(io: &mut BridgeIo, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| format!("failed to encode bridge request: {e}"))?;
    line.push('\n');
    io.stdin
        .write_all(line.as_bytes())
        .and_then(|_| io.stdin.flush())
        .map_err(|e| format!("failed to write to the Apple bridge process: {e}"))
}

#[derive(Debug, Deserialize)]
struct BridgeChunk {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
    done: bool,
}

fn read_next_chunk(io: &mut BridgeIo) -> Result<BridgeChunk, String> {
    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = io
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("failed to read from the Apple bridge process: {e}"))?;
        if bytes_read == 0 {
            return Err("the Apple bridge process closed its output unexpectedly".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        return serde_json::from_str(trimmed).map_err(|e| format!("malformed bridge response line: {e}"));
    }
}

fn respond_buffered(request: tiny_http::Request, io: &mut BridgeIo, id: &str, model: &str) {
    let chunk = match read_next_chunk(io) {
        Ok(chunk) => chunk,
        Err(e) => {
            let _ = request.respond(json_response(502, &json!({ "error": e })));
            return;
        }
    };

    if let Some(error) = chunk.error {
        let _ = request.respond(json_response(502, &json!({ "error": error })));
        return;
    }

    let body = json!({
        "id": id,
        "object": "chat.completion",
        "created": 0,
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": chunk.text.unwrap_or_default() },
            "finish_reason": "stop",
        }],
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    });
    let _ = request.respond(json_response(200, &body));
}

/// Drains every chunk from the bridge (while the stdio lock is held) into one
/// complete SSE payload, then releases the lock and sends it in a single
/// response — see the module doc comment for why this isn't truly
/// incremental over the wire in this first pass.
fn respond_streaming(request: tiny_http::Request, io: &mut BridgeIo, id: &str, model: &str) {
    let mut sse = String::new();
    let mut previous = String::new();

    loop {
        let chunk = match read_next_chunk(io) {
            Ok(chunk) => chunk,
            Err(e) => {
                append_sse_error(&mut sse, &e);
                break;
            }
        };

        if let Some(error) = chunk.error {
            append_sse_error(&mut sse, &error);
            break;
        }

        let text = chunk.text.unwrap_or_default();
        let delta = text.strip_prefix(previous.as_str()).unwrap_or(&text);
        if !delta.is_empty() {
            append_sse_delta(&mut sse, id, model, delta);
        }
        previous = text;

        if chunk.done {
            append_sse_stop(&mut sse, id, model);
            break;
        }
    }

    sse.push_str("data: [DONE]\n\n");

    let response = tiny_http::Response::from_string(sse).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..])
            .expect("static header name/value is always valid"),
    );
    let _ = request.respond(response);
}

fn append_sse_delta(sse: &mut String, id: &str, model: &str, delta: &str) {
    let event = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": model,
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": delta }, "finish_reason": Value::Null }],
    });
    sse.push_str("data: ");
    sse.push_str(&event.to_string());
    sse.push_str("\n\n");
}

fn append_sse_stop(sse: &mut String, id: &str, model: &str) {
    let event = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": model,
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }],
    });
    sse.push_str("data: ");
    sse.push_str(&event.to_string());
    sse.push_str("\n\n");
}

fn append_sse_error(sse: &mut String, message: &str) {
    log::error!("apple bridge streaming error: {message}");
    sse.push_str("data: ");
    sse.push_str(&json!({ "error": message }).to_string());
    sse.push_str("\n\n");
}

fn json_response(status: u16, body: &Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_messages_joins_multiple_system_turns_and_keeps_the_rest_in_order() {
        let parsed = json!({
            "messages": [
                { "role": "system", "content": "Be terse." },
                { "role": "user", "content": "Hi" },
                { "role": "assistant", "content": "Hello." },
                { "role": "system", "content": "Never use emoji." },
                { "role": "user", "content": "How are you?" },
            ]
        });

        let (instructions, rest) = split_messages(&parsed);

        assert_eq!(instructions.as_deref(), Some("Be terse.\n\nNever use emoji."));
        assert_eq!(
            rest,
            vec![
                json!({ "role": "user", "content": "Hi" }),
                json!({ "role": "assistant", "content": "Hello." }),
                json!({ "role": "user", "content": "How are you?" }),
            ]
        );
    }

    #[test]
    fn split_messages_returns_none_instructions_when_there_is_no_system_turn() {
        let parsed = json!({ "messages": [{ "role": "user", "content": "Hi" }] });
        let (instructions, rest) = split_messages(&parsed);

        assert_eq!(instructions, None);
        assert_eq!(rest.len(), 1);
    }

    #[test]
    fn split_messages_maps_an_unexpected_tool_role_onto_user_rather_than_dropping_it() {
        let parsed = json!({ "messages": [{ "role": "tool", "content": "some result" }] });
        let (_, rest) = split_messages(&parsed);

        assert_eq!(rest, vec![json!({ "role": "user", "content": "some result" })]);
    }

    /// Exercises the real HTTP shim against the actually-compiled
    /// ci-apple-bridge binary and Apple's on-device model — not a mock.
    /// Ignored by default (needs a macOS host with Xcode + Apple Intelligence
    /// enabled, and build.rs to have already produced the binary), run
    /// explicitly with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_bridge_answers_chat_completions_over_http() {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let binary = Path::new(&manifest_dir).join("apple-bridge/.build/release/ci-apple-bridge");
        assert!(is_available(&binary), "expected the on-device model to be available on this test host");

        let log_path = std::env::temp_dir().join("ci-apple-bridge-test.log");
        let handle = spawn(&binary, &log_path).expect("spawn should succeed");

        let client = reqwest::blocking::Client::new();
        let base = format!("http://127.0.0.1:{}", handle.port);

        let models: Value = client.get(format!("{base}/v1/models")).send().unwrap().json().unwrap();
        assert_eq!(models["data"][0]["id"], MODEL_ID);

        let non_streaming: Value = client
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": MODEL_ID,
                "stream": false,
                "messages": [
                    { "role": "system", "content": "You are terse." },
                    { "role": "user", "content": "Say hello in exactly 3 words." },
                ],
            }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        let content = non_streaming["choices"][0]["message"]["content"].as_str().unwrap();
        assert!(!content.trim().is_empty());

        let streamed = client
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({
                "model": MODEL_ID,
                "stream": true,
                "messages": [{ "role": "user", "content": "Count from 1 to 3." }],
            }))
            .send()
            .unwrap()
            .text()
            .unwrap();
        assert!(streamed.contains("chat.completion.chunk"));
        assert!(streamed.trim_end().ends_with("data: [DONE]"));

        handle.shutdown();
    }
}
