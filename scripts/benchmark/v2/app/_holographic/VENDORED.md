Vendored from NousResearch/hermes-agent @ main : plugins/memory/holographic/
Files: store.py, retrieval.py, holographic.py (the Hermes-runtime __init__.py plugin glue is NOT vendored).
Two tiny Hermes-runtime shims live in app/: hermes_constants.py, hermes_state.py.
Used by HolographicBackend (backends.py): MemoryStore.add_fact + FactRetriever.search. No LLM/embeddings.
