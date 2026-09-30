package com.companionintelligence.localllm

import android.content.Context
import android.os.PowerManager
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Capabilities
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

private const val TAG = "LocalLlmEngine"

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
 * Closes [resources] in the order given, swallowing (and never skipping past) a failure in any of them.
 * A conversation must be closed *before* the engine it was created from, so callers list the
 * conversation first; and `Engine.close()` throws when the engine never finished initialising, which is
 * exactly when there is nothing left to free.
 */
internal fun closeQuietlyInOrder(vararg resources: AutoCloseable?) {
    for (resource in resources) {
        try {
            resource?.close()
        } catch (e: Exception) {
            // Nothing more to clean up.
        }
    }
}

/**
 * Coroutine-friendly wrapper around a single LiteRT-LM [Engine] + [Conversation], modeled
 * on Google's AI Edge Gallery reference app
 * (`ui/llmchat/LlmChatModelHelper.kt`: `Engine(EngineConfig(...)).initialize()` →
 * `engine.createConversation(ConversationConfig(samplerConfig = SamplerConfig(...)))` →
 * `conversation.sendMessageAsync(contents, MessageCallback, extraContext)`).
 *
 * One model is resident at a time. [load] replaces it; [resetConversation] keeps the engine and
 * starts a fresh conversation on it; [unload] frees both.
 *
 * **Behaviours of LiteRT-LM 0.14.0 this class works around**, each measured on an emulator rather
 * than assumed (see the comments at the point of use): a conversation that was cancelled cannot be
 * continued ([Resident.conversationStale]); a GPU backend can initialise and then fail on its first
 * token ([probeAccelerator]); and on Gemma 4 the thinking mode is fixed by a conversation's first
 * turn ([LocalLlmModelInfo.thinkingFixedPerConversation]).
 *
 * **Concurrency.** Lifecycle calls ([load], [resetConversation], [unload]) are serialised, and each
 * takes the engine *exclusively*: it cancels any generation in flight and waits for the runtime to
 * report that it has stopped before touching the conversation, because closing a native
 * conversation under a running decode is not something LiteRT-LM promises to survive. Only one
 * generation runs at a time — a second [generate]/[generateStreaming] while one is running is
 * rejected, except that a call arriving just after [cancel] waits briefly for the cancelled one to
 * wind down (a "stop" immediately followed by "send" is an ordinary UI sequence).
 */
class LocalLlmEngine(private val context: Context) {

    /**
     * Everything that decides whether the resident model can be reused as-is. [accelerator] is what
     * the caller *asked for* (already defaulted from the model's catalog entry), not what it ran on.
     * [toolsGeneration] changes whenever the intent-tool configuration does, so a tool set built for
     * an old appliance is never reused for a new one.
     */
    data class LoadSpec(
        val info: LocalLlmModelInfo,
        val modelPath: String,
        val maxTokens: Int,
        val topK: Int,
        val topP: Double,
        val temperature: Double,
        val accelerator: LocalLlmAccelerator,
        val enableSpeculativeDecoding: Boolean,
        val toolsGeneration: Long,
    )

    /** What a load actually did — the fields of `LoadModelResult`. */
    data class LoadOutcome(
        val toolCount: Int,
        val accelerator: LocalLlmAccelerator,
        val fellBackToCpu: Boolean,
        val speculativeDecoding: Boolean,
    )

    /** The resident model, for `getLoadedModel` and for validating a generate request against it. */
    data class LoadedModel(val info: LocalLlmModelInfo, val accelerator: LocalLlmAccelerator)

    /** [images] are PNG bytes already prepared by [ImagePreparer]; they go in front of [prompt]. */
    data class GenerateRequest(
        val prompt: String,
        val enableThinking: Boolean = false,
        val images: List<ByteArray> = emptyList(),
    )

    /**
     * A finished generation. [cancelled] is true when it was stopped (by [cancel], the thermal
     * governor, or the caller): [text] then holds what arrived, and there are no [stats] — a
     * truncated run's speed figures would describe nothing the user asked for.
     */
    data class Completion(val text: String, val thought: String, val stats: GenerationStats?, val cancelled: Boolean) {
        init {
            // The invariant JS relies on: a terminal event without stats *means* "stopped". So a stopped
            // generation — by the user, the thermal governor, or a lifecycle call — must never carry any.
            require(!(cancelled && stats != null)) { "A cancelled generation carries no stats" }
        }

        companion object {
            fun cancelled(text: String, thought: String): Completion = Completion(text, thought, stats = null, cancelled = true)

            /**
             * What a generation the runtime reported as *done* becomes. [stopRequested] — a stop was asked for
             * while it ran, or it was abandoned — wins over the runtime's report: a stop that lands as the
             * last token arrives may come back as `onDone` with truncated text, and reporting speed figures
             * for that would tell JS it ran to completion.
             */
            fun finished(text: String, thought: String, stats: GenerationStats, stopRequested: Boolean): Completion =
                if (stopRequested) cancelled(text, thought) else Completion(text, thought, stats, cancelled = false)
        }
    }

    /** One `llmToken` event. */
    data class StreamEvent(val partial: String, val thought: String?, val done: Boolean, val stats: GenerationStats?) {
        companion object {
            /** The terminal (`done = true`) event for [completion]: stats only when it ran to completion. */
            fun terminal(completion: Completion): StreamEvent =
                StreamEvent("", null, done = true, stats = if (completion.cancelled) null else completion.stats)
        }
    }

    private class Resident(
        val spec: LoadSpec,
        val engine: Engine,
        @Volatile var conversation: Conversation,
        val outcome: LoadOutcome,
        /** Kept so [resetConversation] rebinds exactly the tools [load] was given. */
        val tools: List<ToolProvider>,
    ) {
        /**
         * Set when a generation ended any way but success. LiteRT-LM 0.14.0 cannot continue such a
         * conversation: after `cancelProcess()` the next `sendMessageAsync` on the same [Conversation]
         * never delivers a callback (measured on an emulator with a raw `Engine` — 45 s and no
         * `onMessage`/`onDone`/`onError`, with or without a pause in between — while closing the
         * conversation and creating a new one works at once). So the next generation starts on a
         * fresh conversation; see [refreshConversationIfStale].
         */
        @Volatile
        var conversationStale: Boolean = false

        /**
         * The `enable_thinking` value the current conversation's first turn used; null until it has had
         * a turn. Only consulted for a model with [LocalLlmModelInfo.thinkingFixedPerConversation].
         */
        @Volatile
        var conversationThinking: Boolean? = null
    }

    @Volatile
    private var resident: Resident? = null

    @Volatile
    private var activeConversation: Conversation? = null

    /** Admission control for generations and lifecycle calls; see [GenerationGate] for why it hands out tickets. */
    private val gate = GenerationGate()

    private val powerManager: PowerManager?
        get() = context.getSystemService(Context.POWER_SERVICE) as? PowerManager

    /** True once the device is thermally throttled enough that starting inference is unwise. */
    fun isThermallyThrottled(): Boolean = powerManager.isThermallyThrottled()

    fun isLoaded(): Boolean = resident != null

    /** The resident model, or null when nothing is loaded. */
    fun loadedModel(): LoadedModel? = resident?.let { LoadedModel(it.spec.info, it.outcome.accelerator) }

    /**
     * The outcome of the load that produced the resident model if it was made with exactly [spec];
     * null when nothing is loaded or anything differs. Lets the caller skip rebuilding the engine
     * (and re-fetching the intent catalog) for a repeated `loadModel`.
     */
    fun reusableOutcome(spec: LoadSpec): LoadOutcome? = resident?.takeIf { it.spec == spec }?.outcome

    /**
     * Builds the Engine + Conversation for [spec], unloading whatever was resident first (unless it
     * is already exactly this). Blocking — always call from a background dispatcher (see
     * `LocalLlmPlugin`'s `pluginScope`).
     *
     * Tries [LoadSpec.accelerator]; if that is the GPU and it fails to initialise *or to produce a first
     * token* (see [probeAccelerator]), tries the CPU once and reports `fellBackToCpu`. If the CPU fails
     * too, the error carries both messages.
     *
     * @param tools already built by the caller, and only ever non-empty for a model whose catalog
     *   entry has the `tools` capability.
     */
    @Synchronized
    fun load(spec: LoadSpec, tools: List<ToolProvider> = emptyList()): LoadOutcome {
        reusableOutcome(spec)?.let { return it }

        return exclusively(STOP_TIMEOUT_MS, force = true) {
            unloadLocked()
            val created = createResident(spec, tools)
            resident = created
            created.outcome
        }
    }

    /**
     * Discards the conversation — its turn history and KV cache — and starts an empty one on the
     * already-loaded engine, with the sampler and the tool set [load] used. Far cheaper than a
     * reload: the weights stay mapped.
     *
     * Stops any generation in flight first and waits for it to finish; if it will not stop in time
     * this throws and nothing is changed. The old conversation is closed before the new one is
     * created (as Gallery does), so it cannot leak; if creating the new one then fails the model is
     * unloaded rather than left resident with no conversation.
     *
     * @throws IllegalStateException when nothing is loaded, or the running generation would not stop.
     */
    @Synchronized
    fun resetConversation() {
        val current = resident ?: throw IllegalStateException("No model is loaded")

        exclusively(STOP_TIMEOUT_MS, force = false) {
            try {
                replaceConversation(current)
            } catch (e: Exception) {
                unloadLocked()
                throw IllegalStateException("Could not start a new conversation, so the model was unloaded: ${e.message}", e)
            }
        }
    }

    /** Closes [current]'s conversation and puts a fresh one — same sampler, same tools — in its place. */
    private fun replaceConversation(current: Resident) {
        try {
            current.conversation.close()
        } catch (e: Exception) {
            Log.w(TAG, "Closing the old conversation failed; continuing with the replacement", e)
        }
        current.conversation = createConversation(current.engine, current.spec, current.tools)
        current.conversationStale = false
        current.conversationThinking = null
    }

    /**
     * Called with the generation gate held. If the last generation did not finish cleanly the
     * conversation is replaced first — the alternative is a `sendMessageAsync` that never answers.
     * The earlier turns of the chat are gone with it (LiteRT-LM has no way to roll a cancelled turn
     * back), which is the price of "Stop" followed by a new message not hanging forever.
     */
    private fun refreshConversationIfStale(current: Resident) {
        if (!current.conversationStale) return
        try {
            replaceConversation(current)
        } catch (e: Exception) {
            throw IllegalStateException("Could not start a fresh conversation after the previous generation was stopped: ${e.message}", e)
        }
    }

    /**
     * Called with the generation gate held, after [refreshConversationIfStale]. For a model whose template
     * fixes thinking at the conversation's first turn ([LocalLlmModelInfo.thinkingFixedPerConversation]),
     * a request that wants the other mode gets a fresh conversation — the earlier turns are lost, but the
     * alternative is `enableThinking` being silently ignored (or silently stuck on). Records the mode the
     * conversation begins with.
     */
    private fun alignThinkingMode(current: Resident, enableThinking: Boolean) {
        if (current.spec.info.thinkingFixedPerConversation) {
            val began = current.conversationThinking
            if (began != null && began != enableThinking) {
                try {
                    replaceConversation(current)
                } catch (e: Exception) {
                    throw IllegalStateException("Could not start a fresh conversation to change the thinking mode: ${e.message}", e)
                }
            }
        }
        if (current.conversationThinking == null) current.conversationThinking = enableThinking
    }

    /**
     * Closes the active conversation + engine, freeing memory. Safe to call repeatedly. Cancels a
     * generation in flight and gives it a moment to stop; after that it closes regardless (this is
     * also what `handleOnDestroy` runs on the main thread, so it must not wait long).
     */
    @Synchronized
    fun unload() {
        exclusively(UNLOAD_STOP_TIMEOUT_MS, force = true) { unloadLocked() }
    }

    /**
     * Runs [block] — deleting a model's files — with [modelId] guaranteed not to be loaded, and no load able
     * to start until [block] returns. It takes the engine's own monitor, the one [load] holds for its whole
     * duration, so a load *in progress* is waited for and then undone. Checking [loadedModel] instead would
     * see nothing during a load (the resident model is only published when it finishes) and let the file be
     * deleted under `Engine.initialize()`.
     */
    @Synchronized
    fun <T> withModelUnloaded(modelId: String, block: () -> T): T {
        if (resident?.spec?.info?.modelId == modelId) {
            exclusively(STOP_TIMEOUT_MS, force = true) { unloadLocked() }
        }
        return block()
    }

    private fun unloadLocked() {
        val current = resident
        try {
            current?.conversation?.close()
        } catch (e: Exception) {
            // Already closed / never fully initialized — nothing more to clean up.
        }
        try {
            current?.engine?.close()
        } catch (e: Exception) {
            // Same as above.
        }
        resident = null
        activeConversation = null
    }

    // ---- loading ------------------------------------------------------------------------

    private fun createResident(spec: LoadSpec, tools: List<ToolProvider>): Resident {
        // Validate the sampler and window once, up front. SamplerConfig/EngineConfig `require` their
        // arguments, and a bad value thrown from inside the attempt loop below would be blamed on
        // the GPU and retried.
        require(spec.maxTokens > 0) { "maxTokens must be positive, but got ${spec.maxTokens}." }
        SamplerConfig(topK = spec.topK, topP = spec.topP, temperature = spec.temperature)

        val first = LocalLlmPolicy.resolveAccelerator(spec.info, spec.accelerator).accelerator
        val attempts = if (first == LocalLlmAccelerator.GPU) listOf(LocalLlmAccelerator.GPU, LocalLlmAccelerator.CPU) else listOf(first)

        // Only ever on when the caller asked AND the file carries it; an unsupported request is
        // ignored, not an error. `false` (not "leave it to the model") when not asked: a bundle that
        // defaults it on would otherwise run with it while `speculativeDecoding` reports false.
        val speculative = spec.enableSpeculativeDecoding && hasSpeculativeDecodingSupport(spec.modelPath)

        var gpuFailure: Throwable? = null
        for (accelerator in attempts) {
            try {
                val engine = initializeEngine(engineConfigFor(spec, accelerator), speculative)
                // Whichever conversation is open right now, so a failure anywhere below — including the GPU
                // probe, which is the *common* "GPU unusable, fall back to CPU" path — closes it before the
                // engine it belongs to, exactly once.
                var open: Conversation? = null
                val conversation: Conversation
                try {
                    open = createConversation(engine, spec, tools)
                    if (accelerator == LocalLlmAccelerator.GPU) {
                        probeAccelerator(checkNotNull(open))
                        // The probe cancelled its own turn, and LiteRT-LM cannot continue a
                        // cancelled conversation (see Resident.conversationStale) — start clean.
                        val probed = open
                        open = null
                        closeQuietlyInOrder(probed)
                        open = createConversation(engine, spec, tools)
                    }
                    conversation = checkNotNull(open)
                } catch (e: Throwable) {
                    closeQuietlyInOrder(open, engine)
                    throw e
                }
                return Resident(
                    spec = spec,
                    engine = engine,
                    conversation = conversation,
                    outcome =
                        LoadOutcome(
                            toolCount = tools.size,
                            accelerator = accelerator,
                            fellBackToCpu = spec.accelerator == LocalLlmAccelerator.GPU && accelerator == LocalLlmAccelerator.CPU,
                            speculativeDecoding = speculative,
                        ),
                    tools = tools,
                )
            } catch (e: Throwable) {
                // A missing native delegate can surface as a LinkageError rather than an Exception;
                // both mean "this backend will not start". Anything else (OutOfMemoryError…) is not
                // something a retry on the CPU is going to fix.
                if (e !is Exception && e !is LinkageError) throw e
                if (accelerator == LocalLlmAccelerator.GPU) {
                    Log.w(TAG, "GPU initialisation failed for ${spec.info.modelId}; retrying on the CPU", e)
                    gpuFailure = e
                } else if (gpuFailure != null) {
                    throw IllegalStateException("${e.message} (the GPU attempt had also failed: ${gpuFailure.message})", e)
                } else {
                    throw e
                }
            }
        }
        // Unreachable: the GPU is always followed by a CPU attempt, which returns or throws.
        throw IllegalStateException("No backend could load ${spec.info.modelId}")
    }

    private fun engineConfigFor(spec: LoadSpec, accelerator: LocalLlmAccelerator): EngineConfig {
        val backend = backendFor(accelerator)
        // A vision model needs a vision executor or its `Content.ImageBytes` are rejected. It follows
        // the main backend — Gallery runs it on the GPU — so a CPU fallback also moves it to the CPU.
        // The audio executor is never built: this plugin takes no audio.
        val visionBackend = if (spec.info.supportsVision) backendFor(accelerator) else null
        return EngineConfig(
            modelPath = spec.modelPath,
            backend = backend,
            visionBackend = visionBackend,
            audioBackend = null,
            maxNumTokens = spec.maxTokens,
            cacheDir = context.cacheDir.absolutePath,
        )
    }

    private fun backendFor(accelerator: LocalLlmAccelerator): Backend =
        when (accelerator) {
            LocalLlmAccelerator.CPU -> Backend.CPU()
            LocalLlmAccelerator.GPU -> Backend.GPU()
        }

    /**
     * `Engine.initialize()` with the two experimental flags it reads set around it and put back
     * afterwards — both are process-global and "read only when a new Engine is created", so they must
     * not outlive the call. Closes the engine again if initialisation half-succeeded.
     */
    @OptIn(ExperimentalApi::class)
    private fun initializeEngine(config: EngineConfig, speculative: Boolean): Engine {
        val previousSpeculative = ExperimentalFlags.enableSpeculativeDecoding
        val previousBenchmark = ExperimentalFlags.enableBenchmark
        ExperimentalFlags.enableSpeculativeDecoding = speculative
        ExperimentalFlags.enableBenchmark = COLLECT_RUNTIME_BENCHMARK
        val engine = Engine(config)
        try {
            engine.initialize()
            return engine
        } catch (e: Throwable) {
            closeQuietlyInOrder(engine)
            throw e
        } finally {
            ExperimentalFlags.enableSpeculativeDecoding = previousSpeculative
            ExperimentalFlags.enableBenchmark = previousBenchmark
        }
    }

    /** Whether the bundle at [modelPath] ships the multi-token-prediction drafter. False on any error. */
    @OptIn(ExperimentalApi::class)
    private fun hasSpeculativeDecodingSupport(modelPath: String): Boolean =
        try {
            Capabilities(modelPath).use { it.hasSpeculativeDecodingSupport() }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the speculative-decoding capability of $modelPath; treating it as unsupported", e)
            false
        }

    /**
     * Creates the [Conversation]. Tools are fixed at conversation-creation time — LiteRT-LM captures
     * the provider list in the native conversation handle, so they cannot be added per message. That
     * is why the catalog fetch happens during load() rather than lazily on the first tool call.
     */
    @OptIn(ExperimentalApi::class)
    private fun createConversation(engine: Engine, spec: LoadSpec, tools: List<ToolProvider>): Conversation {
        // Read only when a Conversation is created (per LiteRT-LM's own doc comment on the property),
        // so it is set before every createConversation() — load and reset alike. Off by default — see
        // ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING for why this isn't just turned on.
        ExperimentalFlags.enableConversationConstrainedDecoding = ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING
        return engine.createConversation(
            ConversationConfig(
                samplerConfig = SamplerConfig(topK = spec.topK, topP = spec.topP, temperature = spec.temperature),
                systemInstruction = if (tools.isEmpty()) null else Contents.of(TOOL_SYSTEM_INSTRUCTION),
                tools = tools,
            ),
        )
    }

    /**
     * Pushes one token through [conversation] so a GPU that only fails on first use fails *here*, inside
     * [createResident]'s CPU fallback, and not on the user's first message.
     *
     * This is not hypothetical: on an emulator with no OpenCL, `Engine.initialize()` on the GPU backend
     * returned normally (after nearly three minutes) and the first `sendMessageAsync` then failed with
     * "Can not find OpenCL library on this device" — so an `initialize()`-only check would report a GPU
     * load that cannot generate. The probe waits for the first token (or the first error), then cancels the
     * rest; the caller discards the conversation afterwards.
     */
    private fun probeAccelerator(conversation: Conversation) {
        val progressed = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>(null)

        conversation.sendMessageAsync(
            Contents.of(listOf(Content.Text(PROBE_PROMPT))),
            object : MessageCallback {
                override fun onMessage(message: Message) {
                    progressed.countDown()
                }

                override fun onDone() {
                    progressed.countDown()
                    finished.countDown()
                }

                override fun onError(throwable: Throwable) {
                    if (throwable !is CancellationException) failure.set(throwable)
                    progressed.countDown()
                    finished.countDown()
                }
            },
            mapOf(EXTRA_CONTEXT_ENABLE_THINKING to false),
        )

        val answered = progressed.await(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        try {
            conversation.cancelProcess()
        } catch (e: IllegalStateException) {
            // Already finished.
        }
        // Wait for the terminal callback before anything closes the conversation under the native decode.
        val settled = finished.await(PROBE_SETTLE_MS, TimeUnit.MILLISECONDS)

        failure.get()?.let { throw it }
        if (!answered || !settled) {
            throw IllegalStateException("The GPU backend did not produce a token within ${PROBE_TIMEOUT_MS / 1000} seconds")
        }
    }

    // ---- generation ---------------------------------------------------------------------

    /** Non-streaming: buffers every chunk and resolves the concatenated text (and reasoning) once done. */
    suspend fun generate(request: GenerateRequest): Completion = runGeneration(request) { _, _ -> }

    /**
     * Streaming: invokes [onEvent] with each chunk (`done = false`), then once more with `done = true`
     * — carrying [GenerationStats] when the generation ran to completion, and none when it was
     * cancelled. A generation that fails throws instead, with no terminal event.
     */
    suspend fun generateStreaming(request: GenerateRequest, onEvent: (StreamEvent) -> Unit) {
        val completion = runGeneration(request) { text, thought -> onEvent(StreamEvent(text, thought, false, null)) }
        onEvent(StreamEvent.terminal(completion))
    }

    /** Cancels the in-flight generation, if any. Safe to call with nothing in flight. */
    fun cancel() {
        gate.requestCancel()
        try {
            activeConversation?.cancelProcess()
        } catch (e: IllegalStateException) {
            // Conversation already finished/closed — nothing to cancel.
        }
    }

    private suspend fun runGeneration(request: GenerateRequest, onChunk: (text: String, thought: String?) -> Unit): Completion {
        val current = resident ?: throw IllegalStateException("No model is loaded")
        val info = current.spec.info
        if (request.images.isNotEmpty() && !info.supportsVision) {
            throw IllegalArgumentException("${info.modelId} cannot read images; load a model with the vision capability.")
        }
        if (request.prompt.isBlank() && request.images.isEmpty()) {
            throw IllegalArgumentException("prompt is required")
        }
        if (isThermallyThrottled()) throw ThermallyThrottledException()

        // Never true for a model without the capability: its chat template has no thinking slot, and
        // the flag would be rendered into the prompt as noise at best.
        val enableThinking = request.enableThinking && info.supportsThinking
        val contents = contentsFor(request)

        val ticket = gate.begin(CANCEL_GRACE_MS)
        // Re-read after waiting: a load or reset may have replaced the conversation in the meantime.
        val live = resident
        if (live == null || live !== current) {
            gate.end(ticket)
            throw IllegalStateException("The loaded model changed while this request was waiting to start")
        }
        try {
            refreshConversationIfStale(live)
            alignThinkingMode(live, enableThinking)
        } catch (e: Exception) {
            gate.end(ticket)
            throw e
        }
        if (gate.isCancelRequested(ticket)) {
            // A lifecycle call (or the caller) asked for this to stop while the conversation was being replaced.
            gate.end(ticket)
            return Completion.cancelled("", "")
        }
        val conversation = live.conversation

        val text = StringBuilder()
        val thought = StringBuilder()
        var chunks = 0
        var firstTokenNs: Long? = null
        val startNs = System.nanoTime()

        return suspendCancellableCoroutine { cont ->
            activeConversation = conversation
            val finished = AtomicBoolean(false)
            val thermalListener = installThermalCutoff(cont)

            // The generation is over as far as the runtime is concerned only when its callback says so
            // — not when the calling coroutine is cancelled — so this, not the coroutine, releases the gate.
            // Returns true for the first callback even when the gate no longer knows this generation (it was
            // abandoned by a forced unload): the caller still has to be resumed. [GenerationGate.end] is what
            // ignores a stale ticket, and `activeConversation` is only cleared if it is still *this* one.
            fun finish(): Boolean {
                if (!finished.compareAndSet(false, true)) return false
                if (activeConversation === conversation) activeConversation = null
                removeThermalCutoff(thermalListener)
                gate.end(ticket)
                return true
            }

            val callback =
                object : MessageCallback {
                    override fun onMessage(message: Message) {
                        val chunk = message.toString()
                        val reasoning = message.channels[THOUGHT_CHANNEL]?.takeIf { it.isNotEmpty() }
                        if (chunk.isEmpty() && reasoning == null) return

                        if (firstTokenNs == null) firstTokenNs = System.nanoTime()
                        chunks++
                        text.append(chunk)
                        if (reasoning != null) thought.append(reasoning)
                        onChunk(chunk, reasoning)
                    }

                    override fun onDone() {
                        val endNs = System.nanoTime()
                        // Read while the conversation is still guaranteed alive: the gate is released by finish().
                        val runtime = readRuntimeDecodeStats(conversation)
                        val stats = GenerationStatsCalculator.compute(startNs, firstTokenNs, endNs, chunks, runtime)
                        // Sampled before finish() clears it.
                        val stopRequested = gate.isCancelRequested(ticket)
                        if (finish() && cont.isActive) {
                            cont.resume(Completion.finished(text.toString(), thought.toString(), stats, stopRequested))
                        }
                    }

                    override fun onError(throwable: Throwable) {
                        // Cancelled or failed: this conversation cannot be continued (see Resident.conversationStale).
                        live.conversationStale = true
                        if (!finish()) return
                        if (!cont.isActive) return
                        if (throwable is CancellationException) {
                            cont.resume(Completion.cancelled(text.toString(), thought.toString()))
                        } else {
                            cont.resumeWithException(throwable)
                        }
                    }
                }

            try {
                conversation.sendMessageAsync(contents, callback, mapOf(EXTRA_CONTEXT_ENABLE_THINKING to enableThinking))
            } catch (e: Throwable) {
                live.conversationStale = true
                if (finish() && cont.isActive) cont.resumeWithException(e)
                return@suspendCancellableCoroutine
            }

            cont.invokeOnCancellation {
                removeThermalCutoff(thermalListener)
                cancel()
            }
        }
    }

    /** Images first, then the text — Gallery's ordering, so the tokens stay in the sequence the model was trained on. */
    private fun contentsFor(request: GenerateRequest): Contents {
        val parts = ArrayList<Content>(request.images.size + 1)
        for (image in request.images) parts.add(Content.ImageBytes(image))
        if (request.prompt.isNotBlank()) parts.add(Content.Text(request.prompt))
        return Contents.of(parts)
    }

    /**
     * LiteRT-LM's own numbers for the decode that just finished, when the engine was built with
     * benchmarking on. Null (never an exception) when it was not, or the call fails — the caller then
     * falls back to counting streamed chunks.
     */
    @OptIn(ExperimentalApi::class)
    private fun readRuntimeDecodeStats(conversation: Conversation): RuntimeDecodeStats? {
        if (!COLLECT_RUNTIME_BENCHMARK) return null
        return try {
            val info = conversation.getBenchmarkInfo()
            RuntimeDecodeStats(info.lastDecodeTokenCount, info.lastDecodeTokensPerSecond)
        } catch (e: Exception) {
            null
        }
    }

    // ---- the gate -----------------------------------------------------------------------

    /** Takes the engine exclusively for [block]; see [GenerationGate.exclusively]. */
    private fun <T> exclusively(timeoutMs: Long, force: Boolean, block: () -> T): T =
        gate.exclusively(
            timeoutMs,
            force,
            stop = {
                try {
                    activeConversation?.cancelProcess()
                } catch (e: IllegalStateException) {
                    // Already finished.
                }
            },
            block = block,
        )

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

    /** Thrown by [generate]/[generateStreaming] when the device is already thermally throttled. */
    class ThermallyThrottledException :
        IllegalStateException("Device is thermally throttled; declining to start on-device inference")

    private companion object {
        /** The key LiteRT-LM's chat templates read to switch a model's reasoning on. */
        const val EXTRA_CONTEXT_ENABLE_THINKING = "enable_thinking"

        /**
         * The `Message.channels` key reasoning arrives under — `THOUGHT_CHANNEL` in Google AI Edge
         * Gallery's `data/Consts.kt` (verified there: `const val THOUGHT_CHANNEL = "thought"`).
         */
        const val THOUGHT_CHANNEL = "thought"

        /** How long a lifecycle call waits for a cancelled generation to stop before load/reset gives up or forces. */
        const val STOP_TIMEOUT_MS = 10_000L

        /** `unload()` also runs on the main thread from `handleOnDestroy`, where ANR is 5 s away. */
        const val UNLOAD_STOP_TIMEOUT_MS = 1_500L

        /** How long a new generation waits for one that was just cancelled to wind down. */
        const val CANCEL_GRACE_MS = 3_000L

        /** What [probeAccelerator] asks; the answer is thrown away. */
        const val PROBE_PROMPT = "Hi"

        /** First-use GPU kernel compilation is slow on a large model; this is generous, not typical. */
        const val PROBE_TIMEOUT_MS = 180_000L

        /** How long the probe's cancelled turn gets to report that it has stopped. */
        const val PROBE_SETTLE_MS = 30_000L

        /**
         * Build the engine with LiteRT-LM's benchmark mode on so `Conversation.getBenchmarkInfo()`
         * reports the runtime's own decode token count and speed (`ExperimentalFlags.enableBenchmark`
         * is read only at `Engine.initialize()`). When off — or when the read throws — stats fall back
         * to counting streamed chunks and are marked `tokensEstimated`.
         */
        const val COLLECT_RUNTIME_BENCHMARK = true

        /**
         * LiteRT-LM's own grammar/constrained-decoding path for tool calls, "primarily used for
         * function calling" per its doc comment — and, per doc 01 ("Competitive Landscape,
         * Offline and Local Mobile AI" §3), the mechanism most likely to fix the exact failure
         * mode this harness currently risks: tool-call parsing here rides the model's chat-
         * template `<tool_call>` markup with no constrained-decoding safety net.
         *
         * Left OFF by default even so: the whole `ExperimentalFlags` class is annotated
         * `@ExperimentalApi` (a `@RequiresOptIn(level = ERROR)` marker — verified by decompiling
         * the AAR, not assumed — which is why the functions above need their own
         * `@OptIn(ExperimentalApi::class)` just to touch this property at all), and as of this change
         * no commit in this project's history reports a completed real-device inference run at all —
         * turning on an unverified native decoding path on top of an unverified baseline is not a
         * change to make blind. Flip this to `true` once someone can actually run a device (or at
         * minimum an Android emulator, which — unlike the iOS Simulator — is not a confirmed-broken
         * environment for LiteRT-LM) and confirm tool calls still parse correctly.
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
