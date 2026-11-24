package com.companionintelligence.localllm.intents

import org.json.JSONArray
import org.json.JSONObject

/**
 * One intent as published by CI-Server's `GET /api/intents?tier=local`.
 *
 * Only the fields the on-device tool layer actually needs are modeled. In particular there is no
 * `localCapable`/`privacy` mirror here and no re-derivation of the dispatch rule: the server is
 * asked for `tier=local` and returns its own [dispatch] ruling, which this client obeys. The
 * server's `dispatchPolicy.ts` is explicit about why — "two copies of a security rule are two
 * rules" — so the rule stays there and the phone reads the answer.
 */
data class ManifestIntent(
    /** Dotted canonical id, e.g. `memory.recall`. */
    val name: String,
    /** Executable name (dots → underscores), e.g. `memory_recall`. This is what MCP `tools/call` wants. */
    val tool: String,
    val title: String,
    val description: String,
    /** Raw JSON Schema for the arguments, handed to the model verbatim. */
    val parameters: JSONObject,
    val dispatch: DispatchRuling?,
    /** The intent's domain key (`memory`, `planning`, ...); the priority order for a tight window keys on it. */
    val domain: String = "",
)

/** The server's ruling for a tier. Mirrors `DispatchRuling` in `dispatchPolicy.ts`. */
data class DispatchRuling(
    /** `execute` | `queue` | `deny`. */
    val decision: String,
    val reason: String,
    /** One line, safe to hand back to the model as a refusal. */
    val explanation: String,
) {
    val isExecutable: Boolean
        get() = decision == EXECUTE

    companion object {
        const val EXECUTE = "execute"
        const val QUEUE = "queue"
        const val DENY = "deny"
    }
}

/** The parsed manifest. [tier] echoes what the server computed [ManifestIntent.dispatch] for. */
data class IntentManifest(
    val version: String,
    val tier: String?,
    val intents: List<ManifestIntent>,
) {
    /**
     * The intents this device may actually run right now.
     *
     * An intent with no ruling is excluded rather than assumed runnable: a missing `dispatch` means
     * the appliance predates the tier-aware manifest (< 1.2.0), and defaulting an unknown ruling to
     * "execute" would run destructive or third-party-touching intents on a device that cannot show
     * the user what it is about to do.
     */
    fun executable(): List<ManifestIntent> = intents.filter { it.dispatch?.isExecutable == true }

    companion object {
        fun parse(json: JSONObject): IntentManifest {
            val array: JSONArray = json.optJSONArray("intents") ?: JSONArray()
            val intents = buildList {
                for (i in 0 until array.length()) {
                    val entry = array.optJSONObject(i) ?: continue
                    val name = entry.optString("name").takeIf { it.isNotEmpty() } ?: continue

                    add(
                        ManifestIntent(
                            name = name,
                            tool = entry.optString("tool").takeIf { it.isNotEmpty() } ?: name.replace('.', '_'),
                            title = entry.optString("title"),
                            description = entry.optString("description"),
                            parameters = entry.optJSONObject("parameters") ?: JSONObject(),
                            dispatch = entry.optJSONObject("dispatch")?.let {
                                DispatchRuling(
                                    decision = it.optString("decision"),
                                    reason = it.optString("reason"),
                                    explanation = it.optString("explanation"),
                                )
                            },
                            domain = entry.optString("domain"),
                        ),
                    )
                }
            }

            return IntentManifest(
                version = json.optString("version"),
                tier = json.optString("tier").takeIf { it.isNotEmpty() },
                intents = intents,
            )
        }
    }
}
