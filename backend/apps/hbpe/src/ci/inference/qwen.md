# qwen.py

## Purpose
Process-level singleton for the Qwen3.5-0.8B label generator. Replaces Phi-3-mini (llama-cpp-python) with a HuggingFace transformers model. Provides a single `generate()` method used by QwenLabeler.

## Components

### `QwenModel`
- **Does**: Wraps `AutoModelForCausalLM` + `AutoTokenizer` for Qwen3.5-0.8B with greedy decoding
- **Interacts with**: `ci.config.settings.qwen_model_name`, HuggingFace hub (download on first use)
- **Rationale**: `device_map="auto"` + `torch_dtype="auto"` handles CPU/MPS/CUDA transparently without separate build flags

### `QwenModel.generate(user_message, system_message, max_new_tokens)`
- **Does**: Build chat messages → `apply_chat_template(enable_thinking=False)` → generate → decode only new tokens; greedy for deterministic labels
- **Interacts with**: PyTorch, transformers
- **Rationale**: Chat template (not raw completion) is required for instruct models to follow JSON format instructions reliably. `enable_thinking=False` keeps Qwen3.5 in non-thinking mode (no `<think>` blocks in output). Falls back silently for tokenizers that don't support `enable_thinking`. Handles both plain-tensor and BatchEncoding returns from `apply_chat_template` (varies by transformers version).

### `get_qwen()`
- **Does**: Double-checked locking singleton; lazy-loads on first call
- **Interacts with**: `QwenModel`, `ci.config.settings`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `tokenizer/qwen_labeler.py` | `get_qwen().generate(str) → str` | Signature change |

## Notes
- Model download (~1.5 GB) happens on first container start. `HF_HOME=/app/models/hf_cache` in docker-compose points downloads to the persistent `hbpe-models` volume — no redownload on rebuild.
- `trust_remote_code=True` required for Qwen tokenizer custom code
- Qwen3.5-0.8B is a hybrid DeltaNet + standard attention architecture. The "fast path not available" warning (missing `flash-linear-attention`/`causal-conv1d`) is expected on CPU — it falls back to pure-torch and still produces correct results.
