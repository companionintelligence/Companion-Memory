package com.companionintelligence.localllm.intents

import android.util.Log
import com.companionintelligence.localllm.LocalLlmEngine
import com.companionintelligence.localllm.LocalLlmPolicy
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.ToolProvider
import com.google.ai.edge.litertlm.tool
import org.json.JSONObject

/**
 * Binds CI's published intents to LiteRT-LM's tool calling — the Android half of the on-device
 * agent harness.
 *
 * Android can do this **dynamically**: [OpenApiTool] takes a hand-written function-description
 * JSON string and raw argument JSON, so one adapter turns *any* intent the appliance publishes
 * into a callable tool at runtime. Add an intent server-side and the phone picks it up on the next
 * catalog fetch, with no app release.
 *
 * iOS cannot do this, and the difference is structural rather than an oversight: LiteRT-LM's Swift
 * `Tool` is a `Decodable` protocol whose schema is produced by `Mirror`-reflecting compile-time
 * `@ToolParam` properties, and the Swift surface has no `OpenApiTool` equivalent. So the iOS side
 * hand-writes a struct per intent. Both platforms consume the same catalog and obey the same
 * server-computed ruling; only the binding differs.
 */
object IntentToolProvider {
    private const val TAG = "IntentToolProvider"

    /**
     * Builds tool providers for every intent the server says this device may execute.
     *
     * Returns an empty list rather than throwing when the catalog can't be read: a model that
     * answers from its own weights is a worse assistant, but it is still an assistant, whereas a
     * `loadModel()` that fails because the appliance is unreachable would make the offline tier
     * depend on being online — the exact failure the on-device path exists to avoid.
     *
     * @param resultBudgetBytes the most bytes of any one tool result that go back into the model — what the
     *   context window can spare, from [com.companionintelligence.localllm.LocalLlmPolicy.toolResultByteBudget].
     *   Required rather than defaulted: a tool that is not told how much room there is hands back everything
     *   the appliance sent, which is many times the window (see [ToolResultShaper]).
     */
    fun buildProviders(client: CompanionIntentClient, resultBudgetBytes: Int): List<ToolProvider> =
        buildTools(client, resultBudgetBytes).map { tool(it) }

    /**
     * The tools a load of the model is given: everything `loadModel` decides about them, in one place so that a unit test
     * can reach it without a `PluginCall`. None for a model whose chat template has no tool slot, none when no appliance
     * is configured, otherwise every intent the device may run — each holding its answer to the budget of the window THIS
     * load was configured with: [spec]'s `maxTokens`, the effective value and not the model's default.
     */
    fun providersForLoad(spec: LocalLlmEngine.LoadSpec, client: CompanionIntentClient?): List<ToolProvider> =
        toolsForLoad(spec, client).map { tool(it) }

    /** [providersForLoad] before LiteRT-LM wraps each tool: the seam the unit tests call a tool through. */
    internal fun toolsForLoad(spec: LocalLlmEngine.LoadSpec, client: CompanionIntentClient?): List<IntentTool> =
        if (client == null || !spec.info.supportsTools) {
            emptyList()
        } else {
            buildTools(client, LocalLlmPolicy.toolResultByteBudget(spec.maxTokens))
        }

    /** [buildProviders] before LiteRT-LM wraps each tool: the seam the unit tests call a tool through. */
    internal fun buildTools(client: CompanionIntentClient, resultBudgetBytes: Int): List<IntentTool> {
        val manifest =
            try {
                client.fetchManifest()
            } catch (e: Exception) {
                Log.w(TAG, "Intent catalog unavailable; the local model will run without tools", e)

                return emptyList()
            }

        val executable = manifest.executable()

        if (manifest.tier == null) {
            // Pre-1.2.0 appliance: it ignored `?tier=local`, so no ruling came back and
            // `executable()` is empty. Say so explicitly — silently toolless is indistinguishable
            // from "this appliance has no intents", which sends you debugging the wrong thing.
            Log.w(
                TAG,
                "Appliance did not return per-tier dispatch rulings (manifest ${manifest.version}); " +
                    "no tools will be offered. Upgrade CI-Server to 1.2.0+ for on-device tool calling.",
            )
        } else {
            Log.i(
                TAG,
                "Offering ${executable.size} of ${manifest.intents.size} intents to the local model; " +
                    "a tool result is held to $resultBudgetBytes bytes",
            )
        }

        return executable.map { IntentTool(it, client, resultBudgetBytes) }
    }
}

/**
 * One published intent, exposed to the model as an OpenAI-style function.
 *
 * The argument schema is passed through from the catalog untouched, so the model is constrained by
 * the same JSON Schema the appliance validates against — rather than a hand-copied Kotlin
 * approximation that can drift from it.
 *
 * What the model gets back is bounded: the appliance answers with the whole result, and [execute] hands
 * the model at most [resultBudgetBytes] of it (see [ToolResultShaper]).
 */
internal class IntentTool(
    private val intent: ManifestIntent,
    private val client: CompanionIntentClient,
    private val resultBudgetBytes: Int,
) : OpenApiTool {

    override fun getToolDescriptionJsonString(): String =
        JSONObject()
            .put("name", intent.tool)
            .put("description", buildDescription())
            .put("parameters", intent.parameters)
            .toString()

    override fun execute(paramsJsonString: String): String {
        val arguments =
            try {
                if (paramsJsonString.isBlank()) JSONObject() else JSONObject(paramsJsonString)
            } catch (e: Exception) {
                return errorPayload("Arguments were not valid JSON: ${e.message}")
            }

        // Re-check the ruling at call time rather than trusting that only executable intents were
        // registered. Registration and invocation are separated by the whole lifetime of a loaded
        // model, and this is the last chokepoint before a destructive or third-party call would
        // actually leave the device.
        val ruling = intent.dispatch
        if (ruling == null || !ruling.isExecutable) {
            return errorPayload(ruling?.explanation ?: "\"${intent.name}\" may not run on this device")
        }

        val result =
            try {
                client.callTool(intent.tool, arguments)
            } catch (e: Exception) {
                // Handed back as content, not thrown: the model can then tell the user what failed or
                // pick a different intent, whereas an exception aborts the whole generation.
                return errorPayload(e.message ?: "The appliance could not run \"${intent.name}\"")
            }

        // Only the successful answer is shaped. The appliance returns the whole of it — tens of kilobytes
        // for a search — which is far more than the model's context window can take in, and a refusal or
        // a failure above is a sentence.
        val shaped = ToolResultShaper.shape(result, resultBudgetBytes)

        // Sizes and the tool's name only: what a tool returned is the user's data, not log material.
        Log.i(
            TOOL_TAG,
            "${intent.tool} returned ${ToolResultShaper.utf8Length(result)} bytes; " +
                "passing ${ToolResultShaper.utf8Length(shaped)} to the model (budget $resultBudgetBytes)",
        )

        return shaped
    }

    private fun buildDescription(): String =
        if (intent.title.isNotEmpty() && intent.title != intent.description) {
            "${intent.title}. ${intent.description}"
        } else {
            intent.description
        }

    private fun errorPayload(message: String): String = JSONObject().put("error", message).toString()

    private companion object {
        const val TOOL_TAG = "IntentTool"
    }
}
