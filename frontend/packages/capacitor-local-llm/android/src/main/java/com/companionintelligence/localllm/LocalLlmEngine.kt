package com.companionintelligence.localllm

import android.content.Context
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import java.util.concurrent.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Coroutine-friendly wrapper around a single LiteRT-LM [Engine] + [Conversation], modeled
 * on Google's AI Edge Gallery reference app
 * (`ui/llmchat/LlmChatModelHelper.kt`: `Engine(EngineConfig(...)).initialize()` →
 * `engine.createConversation(ConversationConfig(samplerConfig = SamplerConfig(...)))` →
 * `conversation.sendMessageAsync(contents, MessageCallback, extraContext)`). CPU backend
 * only for v1 — the GPU delegate is a later optimization, not required for correctness.
 *
 * Not thread-safe beyond what `LocalLlmPlugin`'s single-flight usage guarantees: callers
 * must not start a new `generate`/`generateStreaming` while one is already in flight.
 */
class LocalLlmEngine(private val context: Context) {
    private var engine: Engine? = null
    private var conversation: Conversation? = null

    @Volatile
    private var activeConversation: Conversation? = null

    @Synchronized
    fun isLoaded(): Boolean = conversation != null

    /**
     * Builds the Engine + Conversation for the `.task` file at [modelPath]. Blocking —
     * always call from a background dispatcher (see `LocalLlmPlugin`'s `pluginScope`).
     */
    @Synchronized
    fun load(modelPath: String, maxTokens: Int, topK: Int, topP: Double, temperature: Double) {
        unload()

        // visionBackend/audioBackend are explicitly null (image/audio input is out of
        // scope for v1 — text-only prompts), matching how the reference app disables
        // them rather than assuming EngineConfig defaults those params on its own.
        val engineConfig =
            EngineConfig(
                modelPath = modelPath,
                backend = Backend.CPU(),
                visionBackend = null,
                audioBackend = null,
                maxNumTokens = maxTokens,
                cacheDir = context.cacheDir.absolutePath,
            )

        val newEngine = Engine(engineConfig)
        newEngine.initialize()

        val newConversation =
            newEngine.createConversation(
                ConversationConfig(
                    samplerConfig = SamplerConfig(topK = topK, topP = topP, temperature = temperature),
                    systemInstruction = null,
                    tools = emptyList(),
                ),
            )

        engine = newEngine
        conversation = newConversation
    }

    /** Closes the active conversation + engine, freeing memory. Safe to call repeatedly. */
    @Synchronized
    fun unload() {
        try {
            conversation?.close()
        } catch (e: Exception) {
            // Already closed / never fully initialized — nothing more to clean up.
        }
        try {
            engine?.close()
        } catch (e: Exception) {
            // Same as above.
        }
        conversation = null
        engine = null
        activeConversation = null
    }

    /** Non-streaming: buffers every `onMessage` chunk, resolving the concatenated text on `onDone`. */
    suspend fun generate(prompt: String): String {
        val conv = conversation ?: throw IllegalStateException("No model is loaded")
        val builder = StringBuilder()

        return suspendCancellableCoroutine { cont ->
            activeConversation = conv

            conv.sendMessageAsync(
                Contents.of(listOf(Content.Text(prompt))),
                object : MessageCallback {
                    override fun onMessage(message: Message) {
                        builder.append(message.toString())
                    }

                    override fun onDone() {
                        activeConversation = null
                        if (cont.isActive) {
                            cont.resume(builder.toString())
                        }
                    }

                    override fun onError(throwable: Throwable) {
                        activeConversation = null
                        if (throwable is CancellationException) {
                            if (cont.isActive) {
                                cont.resume(builder.toString())
                            }
                        } else if (cont.isActive) {
                            cont.resumeWithException(throwable)
                        }
                    }
                },
                mapOf("enable_thinking" to false),
            )

            cont.invokeOnCancellation { cancel() }
        }
    }

    /** Streaming: invokes [onEvent] with each partial (`done = false`), then once more with `done = true`. */
    suspend fun generateStreaming(prompt: String, onEvent: (partial: String, done: Boolean) -> Unit) {
        val conv = conversation ?: throw IllegalStateException("No model is loaded")

        return suspendCancellableCoroutine { cont ->
            activeConversation = conv

            conv.sendMessageAsync(
                Contents.of(listOf(Content.Text(prompt))),
                object : MessageCallback {
                    override fun onMessage(message: Message) {
                        onEvent(message.toString(), false)
                    }

                    override fun onDone() {
                        activeConversation = null
                        onEvent("", true)
                        if (cont.isActive) {
                            cont.resume(Unit)
                        }
                    }

                    override fun onError(throwable: Throwable) {
                        activeConversation = null
                        if (throwable is CancellationException) {
                            onEvent("", true)
                            if (cont.isActive) {
                                cont.resume(Unit)
                            }
                        } else if (cont.isActive) {
                            cont.resumeWithException(throwable)
                        }
                    }
                },
                mapOf("enable_thinking" to false),
            )

            cont.invokeOnCancellation { cancel() }
        }
    }

    /** Cancels the in-flight generation, if any. Safe to call with nothing in flight. */
    fun cancel() {
        try {
            activeConversation?.cancelProcess()
        } catch (e: IllegalStateException) {
            // Conversation already finished/closed — nothing to cancel.
        }
    }
}
