# Patches to the vendored LiteRT-LM Swift wrapper

These files are Google's Swift wrapper for LiteRT-LM (Apache 2.0), copied from the `v0.18.0` release
(`swift/` of the Swift package, every non-test source), because the package cannot be added as an Xcode
target dependency (it needs `-Xlinker -all_load`; see `../../../Frameworks/fetch-clitertlm-xcframework.sh`).
They are otherwise unmodified. Every deviation is marked in the source with `CI PATCH (<name>)`:

```bash
grep -rn "CI PATCH" frontend/apps/ios/ios/App/App/Vendor/LiteRTLM
```

Bumping the xcframework means re-vendoring these files and re-applying what is below, unless upstream
has taken the change. Check each one against the new release first.

**Taken by upstream in 0.18.0, no longer patched here:** `output-cap` (`sendMessageStream(maxOutputTokens:)`
is now upstream's own parameter, applied to every request of the stream) and `conversation-owns-engine`
(`Conversation` now holds `engine: Engine` itself). `Capabilities.swift` was removed upstream; the
speculative-decoding probe is `ModelInfo(modelPath:)?.llm?.hasSpeculativeDecodingSupport()`.

**Re-applied on 0.18.0 (2026-10-12, not yet compiled on a Mac — the bump was done from Linux):**
`continuation-context`, `release-off-callback`, `tokenizer`, `engine-tuning`. The first Xcode build after this
bump is the check; `grep -rn "CI PATCH"` lists every site.

## `engine-tuning` — `Config.swift`, `Engine.swift`

`EngineConfig` gains `prefillChunkSize: Int?` and `numThreads: Int?`, applied in `Engine.initialize()`
through `litert_lm_engine_settings_set_prefill_chunk_size` and `litert_lm_engine_settings_set_num_threads`
(both still exported by the 0.18.0 xcframework headers). The device bench (`tests/local-llm-device`,
`RawSession.swift`) varies them; the app leaves both `nil`.

## `continuation-context` — `Conversation.swift`

`sendMessageStream(_:extraContext:)` handed `extraContext` to the first request only. The request that
carries a tool's result back to the model (`streamCallback`, after `isFinal` with pending tool calls) was
sent with none, so the chat template was rendered without `enable_thinking`, which Qwen3's template reads
as "thinking on", whatever the first request asked for. The non-streaming `sendMessage` loop in the same
file has always passed `extraContext` on every round; the stream now does the same.

- `StreamContext` gains `continuationExtraContext` (set from the call's `extraContext`).
- `sendMessageStream` gains `carryContextThroughToolCalls: Bool = true`. `false` is the upstream
  behaviour, kept so `tests/local-llm-device` can measure what the change is worth.
- The continuation calls `sendToStream(..., extraContext: context.continuationExtraContext, ...)`.

## `tokenizer` — `Engine.swift`

`Engine.tokenCount(of:)` calls `litert_lm_engine_tokenize` and returns the number of tokens the loaded
model's own tokenizer makes of a string. The device bench uses it to measure what the system prompt, the
tool declarations and a tool's result cost in the window.

## `release-off-callback` — `Conversation.swift`

`StreamContext` holds the stream's `Conversation`. If the app has already dropped its own reference
(`LocalLLMEngine.resetConversation()` right after a reply is the case: it waits for `activeGeneration` to
clear, which happens when the final chunk is delivered, and the stream callback has not necessarily returned
yet), the callback's release of the context is the **last** release. It runs `Conversation.deinit` →
`litert_lm_conversation_delete` → `~SessionAdvanced` → `WaitUntilDone()`, on the runtime's callback thread.

That wait cannot succeed. The runtime marks a task finished only **after** its callback returns
(`threaded_execution_manager.cc`: `callback(responses); … UpdateTaskState(task_id, …)`), and the session is
done when it has no active task. It is a self-wait, ended only by `Engine::kDefaultTimeout`, which is
**10 minutes** (`runtime/engine/engine.h`, v0.14.0; unchanged in v0.18.0). The callback thread is shared, so everything queued
behind it — the next generation's output included — waits too.

Seen on a Simulator bench run under heavy host load, which widens the race: two consecutive cells of a
`mode: prod` plan took **683 s** and **606 s** for 128 and 46 tokens (≈ 600 s each, plus the real work);
every other cell of that plan took 10–100 s. `sample` of the stalled process showed LiteRT-LM's
`callback_thread` in `StreamContext.deinit → Conversation.deinit → litert_lm_conversation_delete →
~SessionAdvanced → WaitUntilSessionDone → absl::Mutex::AwaitWithTimeout`, every other runtime thread idle.

The fix is not "release the context on another queue": that was tried first and stalled the same way,
because `streamCallback`'s own local `context` (a strong reference from `takeUnretainedValue()`) is released
at the end of the function, after the queue's release has had time to run, and is then the last one. What
holds is that **no code on the callback thread touches the conversation's reference count**:

- `StreamContext` keeps its conversation as an `Unmanaged<Conversation>`, retained by hand;
- `retireConversation()` takes it out of the context and releases it on a global queue — the only release of
  it, with no local strong reference made on the way (ARC would drop that one on the callback thread, after
  the queue's);
- every path that ends a stream (`finishStream`, and the tool-call `Task`'s `catch`) retires the
  conversation before it lets go of the context, so a `StreamContext` that is freed on the callback thread
  no longer holds anything a destructor waits on.

Whoever else holds the conversation (the app) can still be last, and then the destructor runs on that
thread and waits for the final callback to return — which it does, because nothing on the callback thread is
waiting for it. The release inside the tool-call `Task` already ran off the callback thread and is unchanged.

## Not patched, but worth knowing

- `Conversation.renderMessageIntoString` and the C function behind it dereference a missing `content` in
  `Qwen3DataProcessor::MessageToTemplateInput` (an assistant message that has only `tool_calls`), and
  crash the process. The bench renders through the C entry point and only ever passes messages with a
  `content`; do not call it with anything else.

## `pure-test-build` — `LiteRTLMError.swift`

The Foundation-only suite passes `-D LOCAL_LLM_PURE_TESTS` to compile the actual
error enums without linking the native framework. That flag excludes only the
`CLiteRTLM` import and four native error-management functions; production and
bench builds do not set it and retain the complete upstream API. LiteRT-LM 0.18
added those functions, which otherwise broke the documented framework-free test.
