// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation
import OSLog
import CLiteRTLM

typealias CConversationHandle = OpaquePointer

private let logger = Logger(
  subsystem: "com.google.odml.litertlm.swift",
  category: "Conversation"
)

private let recurringToolCallLimit = 25

/// Represents a conversation with the LiteRT-LM model.
///
/// Example usage:
/// ```swift
/// // Assuming 'engine' is an instance of Engine
/// let conversation = try await engine.createConversation()
///
/// // Send a message and get the response.
/// let response = try conversation.sendMessage(Message("Hello world"))
///
/// // Send a message async with response chunks as AsyncThrowingStream.
/// for try await chunk in conversation.sendMessageStream(Message("Hello world")) {
///   print(chunk.text)
/// }
/// ```
///
/// This class facilitates interaction with the LiteRT-LM model by handling message sending
/// and response reception.
public class Conversation {
  private let logger = Logger(
    subsystem: "com.google.ai.edge.litertlm.swift",
    category: "Conversation"
  )

  private var handle: CConversationHandle?
  private let toolManager: ToolManager
  /// CI PATCH (conversation-owns-engine). The native conversation refers to the native engine, so the
  /// engine must not be deleted first. Nothing in the wrapper held it: an app that dropped its `Engine`
  /// while a stream's context still held this conversation deleted the engine out from under it.
  private let owner: Engine?

  /// Whether the conversation is alive and ready to be used.
  public var isAlive: Bool {
    return handle != nil
  }

  init(handle: CConversationHandle, toolManager: ToolManager, owner: Engine? = nil) {
    self.handle = handle
    self.toolManager = toolManager
    self.owner = owner
  }

  deinit {
    if let handle = handle {
      litert_lm_conversation_delete(handle)
    }
  }

  /// Sends a message to the model and returns the response. This is a synchronous call.
  ///
  /// - Parameter message: The message to send to the model.
  /// - Parameter extraContext: The extra context to send to the model.
  /// - Returns: The model's response message.
  /// - Throws: A `LiteRTLMError` if sending the message fails or the model
  ///   returns an invalid response.
  public func sendMessage(_ message: Message, extraContext: [String: Any]? = nil) async throws
    -> Message
  {
    let handle = try checkIsAlive()

    var currentMessageJson: [String: Any] = message.toJson

    for _ in 0..<recurringToolCallLimit {
      let (responseJson, responseString) = try attemptSendMessage(
        handle: handle, messageJson: currentMessageJson, extraContext: extraContext)

      guard let toolCalls = responseJson["tool_calls"] as? [[String: Any]] else {
        if responseJson["content"] != nil || responseJson["channels"] != nil {
          return try Conversation.jsonToMessage(responseString)
        } else {
          throw LiteRTLMError.conversation(.invalidResponse(responseString))
        }
      }
      currentMessageJson = try await handleToolCalls(toolCalls)
    }
    throw LiteRTLMError.conversation(.recurringToolCallLimitExceeded(limit: recurringToolCallLimit))
  }

  private func attemptSendMessage(
    handle: CConversationHandle, messageJson: [String: Any], extraContext: [String: Any]?
  ) throws
    -> (responseJson: [String: Any], responseString: String)
  {
    let messageData = try JSONSerialization.data(withJSONObject: messageJson)
    guard let messageString = String(data: messageData, encoding: .utf8) else {
      throw LiteRTLMError.conversation(.failedToSerializeMessage)
    }

    var extraContextString: String? = nil
    if let extraContext = extraContext, !extraContext.isEmpty,
      let extraData = try? JSONSerialization.data(withJSONObject: extraContext)
    {
      extraContextString = String(data: extraData, encoding: .utf8)
    }
    let optionalArgs = litert_lm_conversation_optional_args_create()
    if let visualTokenBudget = ExperimentalFlags.visualTokenBudget {
      litert_lm_conversation_optional_args_set_visual_token_budget(
        optionalArgs, Int32(visualTokenBudget))
    }
    defer { litert_lm_conversation_optional_args_delete(optionalArgs) }

    guard
      let responsePtr = litert_lm_conversation_send_message(
        handle, messageString, extraContextString, optionalArgs)
    else {
      throw LiteRTLMError.conversation(.invalidResponse("Native sendMessage returned null."))

    }
    // Delete the response pointer at the end of each iteration. Handled by defer block.
    let responsePtrRef = responsePtr
    defer { litert_lm_json_response_delete(responsePtrRef) }

    guard let responseChars = litert_lm_json_response_get_string(responsePtr) else {
      throw LiteRTLMError.conversation(
        .invalidResponse("Native get string for response returned null."))
    }
    let responseString = String(cString: responseChars)

    guard let responseData = responseString.data(using: .utf8),
      let responseJson = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
    else {
      throw LiteRTLMError.conversation(.invalidJson("Failed to parse native response JSON."))
    }
    return (responseJson, responseString)
  }

  fileprivate func handleToolCalls(_ toolCalls: [[String: Any]]) async throws -> [String: Any] {
    var toolResponses: [[String: Any]] = []

    for toolCall in toolCalls {
      guard let function = toolCall["function"] as? [String: Any],
        let name = function["name"] as? String,
        let argsObject = function["arguments"] as? [String: Any]
      else {
        continue
      }
      do {
        let result = try await toolManager.execute(name: name, arguments: argsObject)

        toolResponses.append([
          "type": "tool_response",
          "name": name,
          "response": result,
        ])
      } catch {
        throw LiteRTLMError.conversation(.toolExecutionError(name: name, error: "\(error)"))
      }
    }

    return ["role": "tool", "content": toolResponses]
  }

  /// Throws an error if the conversation is not alive.
  ///
  /// - Returns: The `OpaquePointer` handle if the conversation is alive.
  /// - Throws: A `LiteRTLMError` if `handle` is nil, indicating the conversation is not alive.
  fileprivate func checkIsAlive() throws -> OpaquePointer {
    guard let handle else {
      throw LiteRTLMError.conversation(.notAlive)
    }
    return handle
  }

  /// Sends a message to the model and returns an async stream of response chunks.
  ///
  /// - Parameter message: The message to send.
  /// - Parameter extraContext: The extra context to send to the model.
  /// - Parameter maxOutputTokens: CI PATCH (output-cap). Caps the tokens decoded for each request
  ///   of this stream (the message itself, and each tool-result continuation). `nil` leaves the
  ///   runtime's default, which is only the room left in the context window.
  /// - Parameter carryContextThroughToolCalls: CI PATCH (continuation-context). Upstream sent
  ///   `extraContext` with the first request only, so the request that carries a tool's result back
  ///   to the model rendered the chat template with no `enable_thinking` at all — which Qwen3's
  ///   template reads as "thinking on", whatever the first request asked for. `sendMessage` (the
  ///   non-streaming call above) has always passed it on every round; this makes the stream do the
  ///   same. Pass `false` to get the upstream behaviour back (the on-device bench uses that to
  ///   measure what the fix is worth).
  /// - Returns: An async throwing stream of `Message` chunks.
  public func sendMessageStream(
    _ message: Message, extraContext: [String: Any]? = nil,
    maxOutputTokens: Int? = nil, carryContextThroughToolCalls: Bool = true
  ) -> AsyncThrowingStream<Message, Error> {
    return AsyncThrowingStream { continuation in
      do {
        let handle = try self.checkIsAlive()
        let messageJson: [String: Any] = message.toJson
        let context = StreamContext(
          continuation: continuation, conversation: self,
          continuationExtraContext: carryContextThroughToolCalls ? extraContext : nil,
          maxOutputTokens: maxOutputTokens)

        try self.sendToStream(
          handle: handle, messageJson: messageJson, extraContext: extraContext, context: context)
      } catch {
        continuation.finish(throwing: error)
      }
    }
  }

  /// Sends a message to the model and handles the response via a streaming callback.
  ///
  /// This function is used internally by `sendMessageStream` and for handling
  /// subsequent tool call responses within the stream.
  ///
  /// - Parameters:
  ///   - handle: The `CConversationHandle` for the current conversation.
  ///   - messageJson: The message to send, represented as a JSON dictionary.
  ///   - extraContext: The extra context to send to the model.
  ///   - context: The `StreamContext` containing the `AsyncThrowingStream.Continuation`
  ///     and other state for the streaming process.
  /// - Throws: A `LiteRTLMError` if the message fails to send or the response is invalid.
  ///   native `send_message_stream` call fails.
  func sendToStream(
    handle: CConversationHandle,
    messageJson: [String: Any],
    extraContext: [String: Any]? = nil,
    context: StreamContext
  ) throws {
    let messageData = try JSONSerialization.data(withJSONObject: messageJson)
    guard let messageString = String(data: messageData, encoding: .utf8) else {
      throw LiteRTLMError.conversation(.failedToSerializeMessage)
    }

    var extraContextString: String? = nil
    if let extraContext = extraContext, !extraContext.isEmpty,
      let extraData = try? JSONSerialization.data(withJSONObject: extraContext)
    {
      extraContextString = String(data: extraData, encoding: .utf8)
    }

    let optionalArgs = litert_lm_conversation_optional_args_create()
    if let visualTokenBudget = ExperimentalFlags.visualTokenBudget {
      litert_lm_conversation_optional_args_set_visual_token_budget(
        optionalArgs, Int32(visualTokenBudget))
    }
    // CI PATCH (output-cap)
    if let maxOutputTokens = context.maxOutputTokens, maxOutputTokens > 0 {
      litert_lm_conversation_optional_args_set_max_output_tokens(
        optionalArgs, Int32(maxOutputTokens))
    }
    defer { litert_lm_conversation_optional_args_delete(optionalArgs) }

    let contextPtr = Unmanaged.passRetained(context).toOpaque()

    let status = litert_lm_conversation_send_message_stream(
      handle,
      messageString,
      extraContextString,
      optionalArgs,
      streamCallback,
      contextPtr
    )

    guard status == 0 else {
      Unmanaged<StreamContext>.fromOpaque(contextPtr).release()
      throw LiteRTLMError.conversation(.failedToStartStream(status: Int(status)))
    }
  }

  /// Cancels the ongoing asynchronous inference process.
  public func cancel() throws {
    let handle = try checkIsAlive()
    litert_lm_conversation_cancel_process(handle)
  }

  /// Renders the message into a string for testing and logging.
  ///
  /// This function does not need to be called for actual message sending, as the `sendMessage` and
  /// `sendMessageStream` functions will handle rendering internally.
  ///
  /// - Parameter message: The message to render.
  /// - Returns: The rendered message string.
  /// - Throws: A `LiteRTLMError` if the conversation is not alive, serializing fails, or rendering fails.
  public func renderMessageIntoString(_ message: Message) throws -> String {
    let handle = try checkIsAlive()
    let messageData = try JSONSerialization.data(withJSONObject: message.toJson)
    guard let messageString = String(data: messageData, encoding: .utf8) else {
      throw LiteRTLMError.conversation(.failedToSerializeMessage)
    }

    guard let cString = litert_lm_conversation_render_message_to_string(handle, messageString)
    else {
      throw LiteRTLMError.conversation(.invalidResponse("Failed to render message into string."))
    }
    return String(cString: cString)
  }

  /// Renders the preface into a string for testing and logging.
  ///
  /// - Returns: The rendered preface string.
  /// - Throws: A `LiteRTLMError` if the conversation is not alive, or rendering fails.
  public func renderPrefaceIntoString() throws -> String {
    let handle = try checkIsAlive()
    guard let cString = litert_lm_conversation_render_preface_to_string(handle) else {
      throw LiteRTLMError.conversation(.invalidResponse("Failed to render preface into string."))
    }
    return String(cString: cString)
  }

  /// Gets the number of tokens in the conversation KV Cache (prefill + decode).
  ///
  /// - Throws: A `LiteRTLMError` if the conversation is not alive.
  public func getTokenCount() throws -> Int {
    let handle = try checkIsAlive()
    return Int(litert_lm_conversation_get_token_count(handle))
  }

  /// Retrieves the benchmark information from the conversation.
  ///
  /// - Returns: The benchmark information
  /// - Throws: A `LiteRTLMError` if the benchmark flag is not enabled or info is unavailable.
  public func getBenchmarkInfo() throws -> BenchmarkInfo {
    let handle = try checkIsAlive()

    if !ExperimentalFlags.enableBenchmark {
      throw LiteRTLMError.conversation(.benchmarkNotEnabled)
    }

    guard let benchmarkInfoPtr = litert_lm_conversation_get_benchmark_info(handle) else {
      throw LiteRTLMError.conversation(.benchmarkInfoUnavailable)
    }
    defer { litert_lm_benchmark_info_delete(benchmarkInfoPtr) }

    let numPrefillTurns = litert_lm_benchmark_info_get_num_prefill_turns(benchmarkInfoPtr)
    let numDecodeTurns = litert_lm_benchmark_info_get_num_decode_turns(benchmarkInfoPtr)

    let initTimeInSecond = litert_lm_benchmark_info_get_total_init_time_in_second(benchmarkInfoPtr)
    let timeToFirstTokenInSecond = litert_lm_benchmark_info_get_time_to_first_token(
      benchmarkInfoPtr)

    let lastPrefillTokenCount: Int =
      numPrefillTurns > 0
      ? Int(
        litert_lm_benchmark_info_get_prefill_token_count_at(
          benchmarkInfoPtr, numPrefillTurns - 1)) : 0
    let lastPrefillTokensPerSec: Double =
      numPrefillTurns > 0
      ? litert_lm_benchmark_info_get_prefill_tokens_per_sec_at(
        benchmarkInfoPtr, numPrefillTurns - 1) : 0.0

    let lastDecodeTokenCount: Int =
      numDecodeTurns > 0
      ? Int(
        litert_lm_benchmark_info_get_decode_token_count_at(
          benchmarkInfoPtr, numDecodeTurns - 1)) : 0
    let lastDecodeTokensPerSec: Double =
      numDecodeTurns > 0
      ? litert_lm_benchmark_info_get_decode_tokens_per_sec_at(
        benchmarkInfoPtr, numDecodeTurns - 1) : 0.0

    return BenchmarkInfo(
      initTimeInSecond: initTimeInSecond,
      timeToFirstTokenInSecond: timeToFirstTokenInSecond,
      lastPrefillTokenCount: lastPrefillTokenCount,
      lastDecodeTokenCount: lastDecodeTokenCount,
      lastPrefillTokensPerSecond: lastPrefillTokensPerSec,
      lastDecodeTokensPerSecond: lastDecodeTokensPerSec
    )
  }

  /// Internal Helper Function to convert a JSON string to a `Message`.
  ///
  /// - Parameter jsonString: The JSON string to convert.
  /// - Returns: The `Message` representation of the JSON string.
  /// - Throws: `LiteRTLMError` if the JSON string is invalid.
  public static func jsonToMessage(_ jsonString: String) throws -> Message {
    guard let data = jsonString.data(using: .utf8),
      let jsonObject = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw LiteRTLMError.message(.failedToConvertToJson)
    }

    var contents: [Content] = []
    if let contentArray = jsonObject["content"] as? [[String: Any]] {
      for item in contentArray {
        if let type = item["type"] as? String, type == "text", let text = item["text"] as? String {
          contents.append(.text(text))
        }
      }
    }

    var channels: [String: String] = [:]
    if let channelsDict = jsonObject["channels"] as? [String: Any] {
      for (key, value) in channelsDict {
        if let strValue = value as? String {
          channels[key] = strValue
        }
      }
    }

    if contents.isEmpty && channels.isEmpty {
      throw LiteRTLMError.message(.invalidContent)
    }

    return Message(contents: contents, channels: channels)
  }

  /// Context object to bridge the C callback to the Swift AsyncThrowingStream.
  class StreamContext {
    let continuation: AsyncThrowingStream<Message, Error>.Continuation
    /// CI PATCH (release-off-callback): the context's reference to its conversation is held by hand, so
    /// the one place it is let go — ``retireConversation()`` — can be somewhere other than the runtime's
    /// callback thread. `nil` once retired.
    private var heldConversation: Unmanaged<Conversation>?
    var conversation: Conversation? { heldConversation?.takeUnretainedValue() }
    /// CI PATCH (continuation-context): sent with every tool-result request of this stream.
    let continuationExtraContext: [String: Any]?
    /// CI PATCH (output-cap): applied to every request of this stream.
    let maxOutputTokens: Int?
    var toolCallCount: Int = 0
    var pendingToolCalls: [[String: Any]] = []

    init(
      continuation: AsyncThrowingStream<Message, Error>.Continuation,
      conversation: Conversation,
      continuationExtraContext: [String: Any]? = nil,
      maxOutputTokens: Int? = nil
    ) {
      self.continuation = continuation
      self.heldConversation = Unmanaged.passRetained(conversation)
      self.continuationExtraContext = continuationExtraContext
      self.maxOutputTokens = maxOutputTokens
    }

    deinit {
      heldConversation?.release()
    }

    /// CI PATCH (release-off-callback). Lets go of the conversation on a global queue, never on the
    /// calling thread.
    ///
    /// When the app has already dropped its own reference (`LocalLLMEngine.resetConversation()` right
    /// after a reply does), this is the **last** one, and the last release runs `Conversation.deinit` →
    /// `litert_lm_conversation_delete` → `~SessionAdvanced` → `WaitUntilDone()`. Run on the runtime's
    /// callback thread — which is where a stream ends — that wait is for a task that is only marked
    /// finished once the callback it is running returns: a self-wait, ended by the runtime's 10 minute
    /// timeout, on the thread every other callback shares. See PATCHES.md.
    ///
    /// The release is the only thing that touches the reference count here: no local strong reference is
    /// made, because ARC would drop that one on this thread, possibly after the queue's release.
    func retireConversation() {
      guard let held = heldConversation else { return }
      heldConversation = nil

      nonisolated(unsafe) let pending = held
      DispatchQueue.global(qos: .utility).async { pending.release() }
    }
  }
}

/// CI PATCH (release-off-callback). The end of a stream, on the callback thread: the conversation goes
/// first (see `StreamContext.retireConversation()`), then the context's own reference. The context
/// itself holds nothing a destructor waits on, so releasing it here is harmless.
private func finishStream(_ context: Conversation.StreamContext, _ userData: UnsafeMutableRawPointer) {
  context.retireConversation()
  Unmanaged<Conversation.StreamContext>.fromOpaque(userData).release()
}

/// A callback function to bridge the C callback to the Swift AsyncThrowingStream.
private func streamCallback(
  userData: UnsafeMutableRawPointer?,
  responseJson: UnsafePointer<CChar>?,
  isFinal: Bool,
  errorMessage: UnsafePointer<CChar>?
) {
  guard let userData = userData else { return }

  let context = Unmanaged<Conversation.StreamContext>.fromOpaque(userData).takeUnretainedValue()

  if let errorMessage = errorMessage {
    let errorString = String(cString: errorMessage)
    let error = LiteRTLMError.conversation(.invalidResponse(errorString))
    context.continuation.finish(throwing: error)

    finishStream(context, userData)
    return
  }

  if let responseJson = responseJson {
    let responseString = String(cString: responseJson)
    do {
      guard let responseData = responseString.data(using: .utf8),
        let jsonObject = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
      else {
        throw LiteRTLMError.conversation(.invalidJson("Invalid JSON chunk"))
      }

      if let toolCalls = jsonObject["tool_calls"] as? [[String: Any]] {
        context.pendingToolCalls.append(contentsOf: toolCalls)
      }

      if jsonObject["content"] != nil || jsonObject["channels"] != nil {
        let message = try Conversation.jsonToMessage(responseString)
        context.continuation.yield(message)
      }
    } catch {
      logger.error("Failed to parse response JSON: \(error.localizedDescription)")
      context.continuation.finish(throwing: error)
      finishStream(context, userData)
      return
    }
  }

  if isFinal {
    if !context.pendingToolCalls.isEmpty {
      if context.toolCallCount >= recurringToolCallLimit {
        context.continuation.finish(
          throwing: LiteRTLMError.conversation(
            .recurringToolCallLimitExceeded(limit: recurringToolCallLimit)))
        finishStream(context, userData)
        return
      }

      context.toolCallCount += 1
      let toolCalls = context.pendingToolCalls
      context.pendingToolCalls = []

      Task {
        do {
          guard let conversation = context.conversation else {
            throw LiteRTLMError.conversation(.notAlive)
          }

          let toolResponseJson = try await conversation.handleToolCalls(toolCalls)
          try conversation.sendToStream(
            handle: conversation.checkIsAlive(),
            messageJson: toolResponseJson,
            extraContext: context.continuationExtraContext,  // CI PATCH (continuation-context)
            context: context
          )
        } catch {
          context.continuation.finish(throwing: error)
          context.retireConversation()  // CI PATCH (release-off-callback)
        }
        // Release the reference for the current (finished) call.
        // The new call from sendToStream created its own retained reference.
        Unmanaged<Conversation.StreamContext>.fromOpaque(userData).release()
      }
    } else {
      context.continuation.finish()
      finishStream(context, userData)
    }
  }
}
