package com.companionintelligence.localllm

import android.content.Context
import android.os.PowerManager
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ToolProvider
import java.util.concurrent.CancellationException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * `PowerManager.getCurrentThermalStatus()` reports at least [PowerManager.THERMAL_STATUS_SEVERE]
 * — the OS is already throttling the CPU/GPU to manage heat, one step before it starts killing
 * background work outright. Nothing in this module checked thermal state at all before this;
 * doc 01 ("Competitive Landscape, Offline and Local Mobile AI", 2026-08-08 §5) measured 700-2,300
 * tokens as the realistic budget before a phone hits this wall during sustained decode, and called
 * the lack of a governor the thing that "invalidates the obvious product design before any code is
 * written." This checks the OS's own live signal rather than counting tokens against a guessed
 * budget, since the guessed number depends on the device, ambient temperature, and case.
 */
private fun PowerManager?.isThermallyThrottled(): Boolean =
    this != null && currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE

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

    private val powerManager: PowerManager?
        get() = context.getSystemService(Context.POWER_SERVICE) as? PowerManager

    /** True once the device is thermally throttled enough that starting inference is unwise. */
    fun isThermallyThrottled(): Boolean = powerManager.isThermallyThrottled()

    @Synchronized
    fun isLoaded(): Boolean = conversation != null

    /**
     * Builds the Engine + Conversation for the model file at [modelPath]. Blocking —
     * always call from a background dispatcher (see `LocalLlmPlugin`'s `pluginScope`).
     */
    @OptIn(ExperimentalApi::class)
    @Synchronized
    fun load(
        modelPath: String,
        maxTokens: Int,
        topK: Int,
        topP: Double,
        temperature: Double,
        tools: List<ToolProvider> = emptyList(),
    ) {
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

        // Read only when a new Conversation is created (per LiteRT-LM's own doc comment on the
        // property), so it must be set before createConversation() below, every load(). Off by
        // default — see ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING for why this isn't just turned on.
        ExperimentalFlags.enableConversationConstrainedDecoding = ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING

        // Tools are fixed at conversation-creation time — LiteRT-LM captures the provider list in
        // the native conversation handle, so they cannot be added per message. That is why the
        // catalog fetch happens during load() rather than lazily on the first tool call.
        val newConversation =
            newEngine.createConversation(
                ConversationConfig(
                    samplerConfig = SamplerConfig(topK = topK, topP = topP, temperature = temperature),
                    systemInstruction = if (tools.isEmpty()) null else Contents.of(TOOL_SYSTEM_INSTRUCTION),
                    tools = tools,
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
        if (isThermallyThrottled()) throw ThermallyThrottledException()
        val builder = StringBuilder()

        return suspendCancellableCoroutine { cont ->
            activeConversation = conv
            val thermalListener = installThermalCutoff(cont)

            conv.sendMessageAsync(
                Contents.of(listOf(Content.Text(prompt))),
                object : MessageCallback {
                    override fun onMessage(message: Message) {
                        builder.append(message.toString())
                    }

                    override fun onDone() {
                        activeConversation = null
                        removeThermalCutoff(thermalListener)
                        if (cont.isActive) {
                            cont.resume(builder.toString())
                        }
                    }

                    override fun onError(throwable: Throwable) {
                        activeConversation = null
                        removeThermalCutoff(thermalListener)
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

            cont.invokeOnCancellation {
                removeThermalCutoff(thermalListener)
                cancel()
            }
        }
    }

    /** Streaming: invokes [onEvent] with each partial (`done = false`), then once more with `done = true`. */
    suspend fun generateStreaming(prompt: String, onEvent: (partial: String, done: Boolean) -> Unit) {
        val conv = conversation ?: throw IllegalStateException("No model is loaded")
        if (isThermallyThrottled()) throw ThermallyThrottledException()

        return suspendCancellableCoroutine { cont ->
            activeConversation = conv
            val thermalListener = installThermalCutoff(cont)

            conv.sendMessageAsync(
                Contents.of(listOf(Content.Text(prompt))),
                object : MessageCallback {
                    override fun onMessage(message: Message) {
                        onEvent(message.toString(), false)
                    }

                    override fun onDone() {
                        activeConversation = null
                        removeThermalCutoff(thermalListener)
                        onEvent("", true)
                        if (cont.isActive) {
                            cont.resume(Unit)
                        }
                    }

                    override fun onError(throwable: Throwable) {
                        activeConversation = null
                        removeThermalCutoff(thermalListener)
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

            cont.invokeOnCancellation {
                removeThermalCutoff(thermalListener)
                cancel()
            }
        }
    }

    /**
     * Registers a listener that cancels [cont]'s in-flight generation the moment the device
     * crosses [PowerManager.THERMAL_STATUS_SEVERE] mid-stream, rather than only refusing to
     * *start* a new one. A short answer is a better outcome than one this device's thermal
     * governor was going to throttle or truncate anyway.
     */
    private fun installThermalCutoff(cont: kotlinx.coroutines.CancellableContinuation<*>): PowerManager.OnThermalStatusChangedListener? {
        val manager = powerManager ?: return null
        val listener =
            PowerManager.OnThermalStatusChangedListener { status ->
                if (status >= PowerManager.THERMAL_STATUS_SEVERE && cont.isActive) {
                    cancel()
                }
            }
        manager.addThermalStatusListener(listener)
        return listener
    }

    private fun removeThermalCutoff(listener: PowerManager.OnThermalStatusChangedListener?) {
        if (listener != null) {
            powerManager?.removeThermalStatusListener(listener)
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

    /** Thrown by [generate]/[generateStreaming] when the device is already thermally throttled. */
    class ThermallyThrottledException :
        IllegalStateException("Device is thermally throttled; declining to start on-device inference")

    private companion object {
        /**
         * LiteRT-LM's own grammar/constrained-decoding path for tool calls, "primarily used for
         * function calling" per its doc comment — and, per doc 01 ("Competitive Landscape,
         * Offline and Local Mobile AI" §3), the mechanism most likely to fix the exact failure
         * mode this harness currently risks: tool-call parsing here rides the model's chat-
         * template `<tool_call>` markup with no constrained-decoding safety net.
         *
         * Left OFF by default even so: the whole `ExperimentalFlags` class is annotated
         * `@ExperimentalApi` (a `@RequiresOptIn(level = ERROR)` marker — verified by decompiling
         * the AAR, not assumed — which is why `load()` above needs its own `@OptIn(ExperimentalApi::class)`
         * just to touch this property at all), and as of this change no commit in this project's
         * history reports a completed real-device inference run at all — turning on an unverified
         * native decoding path on top of an unverified baseline is not a change to make blind. Flip
         * this to `true` once someone can actually run a device (or at minimum an Android emulator,
         * which — unlike the iOS Simulator — is not a confirmed-broken environment for LiteRT-LM)
         * and confirm tool calls still parse correctly.
         */
        const val ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING = false

        /**
         * Scopes the local model to the user's own memory. Deliberately narrow: the disconnected-mode
         * design's explicit non-goal is "a general-purpose local chatbot" — that category is free and
         * saturated, and a 1B model competing there loses. Its job is answering from *your* records,
         * which is also the only thing it can do better than a cloud model.
         */
        const val TOOL_SYSTEM_INSTRUCTION =
            "You are Companion, answering questions about the user's own memory on their device. " +
                "Use the provided tools to look things up rather than guessing, and cite what you found. " +
                "If a tool reports an error or says an action must be confirmed on the appliance, tell " +
                "the user plainly instead of pretending it succeeded."
    }
}
