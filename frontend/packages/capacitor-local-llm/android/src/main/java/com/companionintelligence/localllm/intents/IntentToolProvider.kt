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
     * is configured and no replica is on the phone, otherwise every intent the device may run — each holding its answer
     * to the budget of the window THIS load was configured with: [spec]'s `maxTokens`, the effective value and not the
     * model's default.
     *
     * The phone's own search ([LocalSearchTool]) joins the set when [local] has a replica to read, in one of two ways:
     * in place of the appliance's `knowledge_search` when the app is not connected ([preferLocal]) — the appliance's
     * would fail anyway — and as the whole set when the appliance's catalog could not be fetched, which until 2026-10-22
     * left the model with no tools at all.
     */
    fun providersForLoad(
        spec: LocalLlmEngine.LoadSpec,
        client: CompanionIntentClient?,
        local: LocalSearchSource? = null,
        preferLocal: Boolean = false,
    ): List<ToolProvider> = toolsForLoad(spec, client, local, preferLocal).map { tool(it) }

    /** [providersForLoad] before LiteRT-LM wraps each tool: the seam the unit tests call a tool through. */
    internal fun toolsForLoad(
        spec: LocalLlmEngine.LoadSpec,
        client: CompanionIntentClient?,
        local: LocalSearchSource? = null,
        preferLocal: Boolean = false,
    ): List<OpenApiTool> {
        if (!spec.info.supportsTools) return emptyList()

        val resultBudget = LocalLlmPolicy.toolResultByteBudget(spec.maxTokens)
        val appliance: List<OpenApiTool> =
            if (client == null) {
                emptyList()
            } else {
                buildTools(client, resultBudget, LocalLlmPolicy.toolDeclarationTokenBudget(spec.maxTokens))
            }

        if (local == null || !local.isAvailable()) return appliance

        val applianceSearch = appliance.filterIsInstance<IntentTool>().any { it.name == LocalSearchTool.NAME }

        if (applianceSearch && !preferLocal) return appliance

        if (preferLocal) {
            Log.i(TAG, "Not connected: ${LocalSearchTool.NAME} answers from this phone's replica")
        } else {
            Log.i(TAG, "The appliance offered no ${LocalSearchTool.NAME}; this phone's replica answers it")
        }

        return appliance.filter { !(it is IntentTool && it.name == LocalSearchTool.NAME) } + LocalSearchTool(local, resultBudget)
    }

    /**
     * [buildProviders] before LiteRT-LM wraps each tool: the seam the unit tests call a tool through.
     *
     * @param declarationTokenBudget the most tokens all the declarations together may take in the prompt, from
     *   [LocalLlmPolicy.toolDeclarationTokenBudget]; `Int.MAX_VALUE` binds everything the server allows.
     */
    internal fun buildTools(
        client: CompanionIntentClient,
        resultBudgetBytes: Int,
        declarationTokenBudget: Int = Int.MAX_VALUE,
    ): List<IntentTool> {
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
        }

        val selection = selectWithinBudget(executable, declarationTokenBudget)
        if (manifest.tier != null) {
            Log.i(
                TAG,
                "Offering ${selection.kept.size} of ${manifest.intents.size} intents to the local model " +
                    "(${executable.size} may run here; declarations take ~${selection.keptTokens} of a " +
                    "$declarationTokenBudget-token budget); a tool result is held to $resultBudgetBytes bytes",
            )
        }
        if (selection.omitted.isNotEmpty()) {
            Log.w(
                TAG,
                "${selection.omitted.size} intent(s) left out: their declarations would not fit the window. " +
                    "Omitted: ${selection.omitted.joinToString { it.name }}",
            )
        }

        return selection.kept.map { IntentTool(it, client, resultBudgetBytes) }
    }

    /** What [selectWithinBudget] decided, so the caller can say what it left out. */
    internal data class Selection(val kept: List<ManifestIntent>, val omitted: List<ManifestIntent>, val keptTokens: Int)

    /**
     * The intents whose declarations fit [budgetTokens] together, most useful first.
     *
     * Order: [PRIORITY_INTENTS] by position, then everything else by [PRIORITY_DOMAINS], then by name, so
     * an intent the appliance adds tomorrow still lands somewhere sensible without an app release.
     * Greedy and first-fit: an intent whose declaration does not fit is skipped, not a stopping point,
     * so a small intent further down still gets in after a large one was passed over. The cost of each
     * is the declaration exactly as the model would see it ([IntentTool.declaration]), estimated with
     * [LocalLlmPolicy.estimateDeclarationTokens].
     */
    internal fun selectWithinBudget(intents: List<ManifestIntent>, budgetTokens: Int): Selection {
        val ordered = intents.sortedWith(compareBy({ priorityRank(it) }, { it.name }))
        val kept = ArrayList<ManifestIntent>()
        val omitted = ArrayList<ManifestIntent>()
        var spent = 0
        for (intent in ordered) {
            val cost = LocalLlmPolicy.estimateDeclarationTokens(IntentTool.declaration(intent).toByteArray(Charsets.UTF_8).size)
            if (spent + cost <= budgetTokens) {
                kept += intent
                spent += cost
            } else {
                omitted += intent
            }
        }
        return Selection(kept, omitted, spent)
    }

    private fun priorityRank(intent: ManifestIntent): Int {
        val explicit = PRIORITY_INTENTS.indexOf(intent.name)
        if (explicit >= 0) return explicit
        val domain = PRIORITY_DOMAINS.indexOf(intent.domain)
        return PRIORITY_INTENTS.size + (if (domain >= 0) domain else PRIORITY_DOMAINS.size)
    }

    /**
     * The intents the offline surface exists for, in the order they are worth their tokens: finding
     * things the user already has, then recording, then the rest. A preference, not a gate -- what is
     * not listed is ordered by [PRIORITY_DOMAINS] after these.
     */
    internal val PRIORITY_INTENTS: List<String> =
        listOf(
            "knowledge.search",
            "memory.recall",
            "people.find",
            "media.findPhotos",
            "planning.findTasks",
            "places.find",
            "calendar.findEvents",
            "memory.remember",
            "planning.createTask",
            "knowledge.preferences",
        )

    /** Domain order for intents not named in [PRIORITY_INTENTS]; unknown domains go last. */
    internal val PRIORITY_DOMAINS: List<String> =
        listOf("knowledge", "memory", "people", "places", "planning", "calendar", "media", "brief", "insights", "anomalies", "suggestions")
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
    /** The MCP name the model calls this by. */
    val name: String
        get() = intent.tool

    override fun getToolDescriptionJsonString(): String = declaration(intent)

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

    private fun errorPayload(message: String): String = JSONObject().put("error", message).toString()

    companion object {
        private const val TOOL_TAG = "IntentTool"

        /** The function declaration exactly as the model is given it -- also what the declaration budget is measured on. */
        fun declaration(intent: ManifestIntent): String =
            JSONObject()
                .put("name", intent.tool)
                .put("description", buildDescription(intent))
                .put("parameters", intent.parameters)
                .toString()

        private fun buildDescription(intent: ManifestIntent): String =
            if (intent.title.isNotEmpty() && intent.title != intent.description) {
                "${intent.title}. ${intent.description}"
            } else {
                intent.description
            }
    }
}
