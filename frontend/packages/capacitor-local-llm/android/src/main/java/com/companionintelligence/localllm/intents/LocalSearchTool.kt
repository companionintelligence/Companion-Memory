package com.companionintelligence.localllm.intents

import android.util.Log
import com.google.ai.edge.litertlm.OpenApiTool
import org.json.JSONArray
import org.json.JSONObject

/**
 * `knowledge_search` answered from the phone's replica (see [LocalSearch]).
 *
 * Bound in place of the appliance's tool when the appliance's catalog cannot be fetched — which used
 * to leave the model with no tools at all — and ahead of it while the app is not connected. Same
 * name, same lean parameters, same envelope, so nothing else in the harness tells the two apart.
 */
internal class LocalSearchTool(
    private val source: LocalSearchSource,
    private val resultBudgetBytes: Int,
) : OpenApiTool {
    val name: String
        get() = NAME

    override fun getToolDescriptionJsonString(): String = declaration()

    override fun execute(paramsJsonString: String): String {
        val arguments =
            try {
                if (paramsJsonString.isBlank()) JSONObject() else JSONObject(paramsJsonString)
            } catch (e: Exception) {
                return JSONObject().put("error", "Arguments were not valid JSON: ${e.message}").toString()
            }

        val result =
            try {
                LocalSearch.run(source, LocalSearchArgs.fromJson(arguments))
            } catch (e: Exception) {
                Log.w(TAG, "The phone's search index could not be read", e)

                return JSONObject().put("error", "This phone's copy of your memory could not be searched: ${e.message}").toString()
            }

        val shaped = ToolResultShaper.shape(result, resultBudgetBytes)

        // Sizes only: what a search returned is the user's data, not log material.
        Log.i(TAG, "$NAME (phone) returned ${ToolResultShaper.utf8Length(result)} bytes; passing ${ToolResultShaper.utf8Length(shaped)} to the model (budget $resultBudgetBytes)")

        return shaped
    }

    companion object {
        private const val TAG = "LocalSearchTool"

        /** The MCP name, which is what the model emits and what the appliance's own tool is called. */
        const val NAME = "knowledge_search"

        /**
         * The appliance's lean local-tier form of `knowledge.search` (`DatabaseSearchTool.ts`, `schema.local`),
         * copied here because the one place it is published — the intent catalog — is exactly what is
         * unreachable when this tool is needed. `LocalSearchToolTest` holds this copy against the TypeScript.
         */
        const val DESCRIPTION =
            "Search everything you have: people, places, notes, messages, files, events. " +
                "For \"most recent\" or \"latest\" set sort to recent. " +
                "For \"how many\" questions set countOnly and use one specific word."

        fun parameters(): JSONObject =
            JSONObject()
                .put("type", "object")
                .put(
                    "properties",
                    JSONObject()
                        .put("query", JSONObject().put("type", "string").put("description", "Keywords to search for.").put("maxLength", 500))
                        .put(
                            "entityTypes",
                            JSONObject()
                                .put("type", "array")
                                .put("items", JSONObject().put("type", "string").put("enum", JSONArray(LocalSearch.LEAN_ENTITY_TYPES)))
                                .put(
                                    "description",
                                    "Only these kinds: communication = a message, email or call; content = a photo or video; " +
                                        "file = a document; event = a calendar entry; note; person; place; receipt; task.",
                                ),
                        )
                        .put("since", JSONObject().put("type", "string").put("description", "Only entries on or after this date, YYYY-MM-DD.").put("maxLength", 40))
                        .put("until", JSONObject().put("type", "string").put("description", "Only entries on or before this date, YYYY-MM-DD.").put("maxLength", 40))
                        .put(
                            "sort",
                            JSONObject()
                                .put("type", "string")
                                .put("enum", JSONArray().put("recent"))
                                .put("description", "recent = newest first. Use for \"most recent\", \"latest\", \"last\"."),
                        )
                        .put("countOnly", JSONObject().put("type", "boolean").put("description", "Return only the exact count, no items.")),
                )
                .put("required", JSONArray())
                .put("additionalProperties", false)

        fun declaration(): String =
            JSONObject().put("name", NAME).put("description", DESCRIPTION).put("parameters", parameters()).toString()
    }
}
