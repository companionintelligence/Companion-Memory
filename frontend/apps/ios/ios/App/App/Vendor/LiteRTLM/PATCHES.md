# Patches to the vendored LiteRT-LM Swift wrapper

These files are Google's Swift wrapper for LiteRT-LM (Apache 2.0), copied from the `v0.14.0` release
(`Sources/` of the Swift package), because the package cannot be added as an Xcode target dependency
(it needs `-Xlinker -all_load`; see `../../../Frameworks/fetch-clitertlm-xcframework.sh`). They are
otherwise unmodified. Every deviation is marked in the source with `CI PATCH (<name>)`:

```bash
grep -rn "CI PATCH" frontend/apps/ios/ios/App/App/Vendor/LiteRTLM
```

Bumping the xcframework means re-vendoring these files and re-applying what is below, unless upstream
has taken the change. Check each one against the new release first.

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

## `output-cap` — `Conversation.swift`

The C entry point has `litert_lm_conversation_optional_args_set_max_output_tokens`; the Swift wrapper
never set it. `sendMessageStream` gains `maxOutputTokens: Int?`, stored in `StreamContext` and applied to
every request of the stream (the message itself and each tool-result continuation).

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
**10 minutes** (`runtime/engine/engine.h`, v0.14.0). The callback thread is shared, so everything queued
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

## `conversation-owns-engine` — `Conversation.swift`, `Engine.swift`

The native conversation refers to the native engine, so the engine must be deleted second. Nothing in the
wrapper enforced it: `LocalLLMEngine.teardown()` drops the conversation and then the engine, and if a stream's
context still held the conversation the engine was deleted underneath it. With `release-off-callback` the
conversation can now be deleted a moment after the app let go of it, on a queue, so this is no longer a rare
case. `Conversation` keeps a strong reference to the `Engine` that created it (`owner`), so the engine
outlives every conversation.

## Not patched, but worth knowing

- `Conversation.renderMessageIntoString` and the C function behind it dereference a missing `content` in
  `Qwen3DataProcessor::MessageToTemplateInput` (an assistant message that has only `tool_calls`), and
  crash the process. The bench renders through the C entry point and only ever passes messages with a
  `content`; do not call it with anything else.
