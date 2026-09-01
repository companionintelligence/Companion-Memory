# GPU model residency and Ollama tuning

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

A shipped appliance runs a chat model, an embedding model, the HBPE sidecar and
the summary sidecar against **one** GPU. Three Ollama settings decide how they
share it, and two of the three are routinely blamed for problems they do not
cause. This page records what each one actually does, measured on a live
appliance rather than reasoned about.

Measured 2026-09-01 on `fzzy` (AI MAX+ 395 / Radeon 8060S, 122.8 GiB unified
memory, ROCm, Ollama 0.32.5), chat model `gemma4:31b` (Q4_K_M), embedding model
`nomic-embed-text`. Re-measure before trusting these numbers on other hardware —
the *shape* of the conclusions generalises, the absolute figures do not.

## The one-paragraph version

`OLLAMA_MAX_LOADED_MODELS` is the setting that matters, it must be at least 2,
and on this appliance it already is. `OLLAMA_NUM_PARALLEL` is pinned at 1 by
Ollama's own default and **no context change will move it** — only setting the
variable will. `num_ctx` is the underrated one: the chat model's native 262144
window costs **37 GiB of admission budget and 2–9× slower cold loads while
buying nothing measurable**, and capping it is the highest-value change
available.

## Measured baseline

Both models resident, `OLLAMA_MAX_LOADED_MODELS=2`, `OLLAMA_NUM_PARALLEL=1`:

| Metric | Value |
|---|---|
| Embedding throughput, batch 1 / 8 / 32 / 64 | 27 / 93 / 129 / 139 texts·s⁻¹ |
| Embedding throughput **with the 20 GiB chat model co-resident** | 104 / 127 / 143 texts·s⁻¹ (batch 8/32/64) |
| Chat TTFT, warm | **1.12 s** (three runs: 1.12 / 1.12 / 1.11) |
| Chat TTFT, warm, immediately after a burst of embedding traffic | **1.12 s** — unchanged |
| Chat TTFT, cold (includes loading 24 GB of weights) | 9.7 s at `num_ctx=8192` |
| Chat generation rate | ~10 tok·s⁻¹ |

Embedding throughput is **the same or better** with the chat model resident, and
chat TTFT is **identical** before and after embedding traffic. `ollama ps`
confirms both stay resident simultaneously. There is no swap contention between
these two models at the current settings.

## `OLLAMA_MAX_LOADED_MODELS` — the one that matters

At `1`, the chat and embedding models cannot both stay resident, so every
embedding batch arriving while chat is loaded evicts the chat model, loads the
embedder, and gets evicted again on the next chat request. That is weight
reloading, not queuing, and no application-side concurrency limit
(`CI_EMBED_CONCURRENCY` and friends) can help — those bound how many HTTP
requests the app sends, not whether Ollama reloads weights between them.

**On this appliance it was already raised to 2 on 2026-08-30 01:40** and has been
live across every restart since. The effect is visible in the journal:

| | Runner launches (model loads) per day |
|---|---|
| Aug 25 – Aug 29 (cap = 1) | 2702, 402, 3, 1031, 1356 |
| Aug 30 (changed 01:40) | 431 |
| Aug 31 / Sep 01 (cap = 2) | **29 / 103** |

A 10–40× drop in load events, and 481 `llama-server model fits alongside
existing models` admissions — a log line that appears **only** after the change
and never before it.

### The fit estimate still gets a veto

Raising the cap does not guarantee co-residency. Ollama predicts whether the
second model fits before keeping it resident and evicts the LRU model if the
estimate says no. That fired three times, all on Aug 30, all with
`predicted="57.9 GiB"` against ~56–61 GiB available — the chat model at its full
262144 context is large enough that a second model is a coin-flip. See `num_ctx`
below: shrinking the window is what makes co-residency reliable rather than
marginal.

## `OLLAMA_NUM_PARALLEL` — not auto, and not caused by context

It is tempting to read `-np 1` on the chat model's `llama-server` child as Ollama
having *auto-picked* one slot because a 262144-token KV cache is huge, and to
conclude that shrinking the context will let `-np` rise. **That is wrong, and it
is worth being precise about because it sends the fix in the wrong direction.**

Two independent pieces of evidence:

1. The server config banner logs `OLLAMA_NUM_PARALLEL:1` on every boot, with the
   variable unset in the unit. It is the build's default, not a computed value.
   (Contrast `OLLAMA_CONTEXT_LENGTH:0`, which *is* how this build spells "auto".)
2. **`nomic-embed-text` — 274 MB, `-c 2048` — was launched 4075 times and got
   `-np 1` every single time**, on a box with 60 GiB of free GPU budget. A model
   that small with a window that short would trivially admit four slots under any
   memory-derived heuristic. Across the entire journal, 9502 of 9502 runner
   launches used `-np 1`, at every context size and model size.

So `-np` is pinned regardless of headroom. **Reducing `num_ctx` will not raise
it.** If concurrent same-model requests are wanted, `OLLAMA_NUM_PARALLEL` must be
set explicitly — and because each slot gets its own KV cache, setting it above 1
*requires* capping `num_ctx` first. The dependency runs the opposite way from the
intuition: the context cap is the **enabler** for parallelism, not its cause.

Whether to set it at all is a real decision, not an obvious win. Today chat
requests serialise. On an appliance serving one household that is usually fine,
and a second slot doubles KV cost to buy concurrency that may never be exercised.
Set it when there is evidence of chat requests queuing behind each other; leave
it at 1 otherwise.

## `num_ctx` — the underrated lever

The chat model declares a 262144-token window and, absent an override, Ollama
asks for all of it. That is expensive in a way that does not show up in steady
state:

| `num_ctx` | Predicted (what the scheduler admits on) | Actually resident | Cold TTFT | Warm TTFT | tok·s⁻¹ |
|---|---|---|---|---|---|
| 8 192 | **20.5 GiB** | 19.4 GiB | **9.9–10.5 s** | 1.84 s | 5.9 |
| 32 768 | 24.2 GiB | 19.4 GiB | 11.8 s | 1.74 s | 5.1 |
| 65 536 | 30.3 GiB | 20.5 GiB | 12.3 s | 1.76 s | 5.9 |
| 262 144 | **57.9 GiB** | 20.5 GiB | **20.7–88.3 s** | 1.76 s | 6.0 |

Three things to read off it:

- **The prediction nearly triples (20.5 → 57.9 GiB) while actual residency barely
  moves (19.4 → 20.5 GiB).** The 37 GiB gap is phantom: budget the scheduler
  reserves against but the model never uses. It is what caused the three
  evictions above, and it is why nothing substantial can co-reside with chat.
- **Cold loads get 2–9× slower and wildly variable** — 9.9–10.5 s at 8192 (tight)
  against 20.7–88.3 s at 262144. This has teeth beyond impatience: background
  jobs bound at a 60 s timeout **cannot** survive a cold load at the full window,
  and fail with a generic LLM timeout that names neither the model nor the cause.
  At 8192 the same load finishes with 50 s to spare.
- **Warm TTFT and generation rate are flat** — 1.74–1.84 s and 5–6 tok·s⁻¹ at
  every window. The large context buys nothing once the model is warm.

The only real cost of capping is maximum conversation length. `CI_LLM_NUM_CTX`
(see `backend/apps/api/src/domains/llm/contextBudget.ts`) is the app-side knob and
CI-Hub exports it with a hardware-appropriate value; `OLLAMA_CONTEXT_LENGTH` is
the host-side equivalent when nothing sets the former.

### Side-finding: a 262144 request is reaching models that cannot honour it

The journal carries 3286 `requested context size too large for model` warnings,
including `num_ctx=262144 n_ctx_train=32768` against `gemma3n:e4b` and
`num_ctx=8192 n_ctx_train=2048` against `nomic-embed-text`. Something is applying
one model's window to every model. `CI_LLM_NUM_CTX` is unset on the appliance's
containers, so this is not CI-Server's context budget — the source is still
unidentified and is worth tracing, because the over-request is what inflates the
admission prediction.

## HBPE is invisible to all of this

HBPE holds the GPU through `/dev/kfd` directly, outside Ollama's process tree.
Whatever it occupies is **not** in Ollama's fit calculation at any setting, so
cross-process contention is real and cannot be tuned away from the Ollama side.
This is an argument for leaving genuine headroom rather than sizing models to
exactly fill the GPU — another reason to cap `num_ctx` rather than run at 57.9
GiB of predicted footprint.

## Recommended settings

```ini
# /etc/systemd/system/ollama.service.d/override.conf
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
Environment="OLLAMA_MAX_LOADED_MODELS=2"   # already set; required, not optional
Environment="OLLAMA_CONTEXT_LENGTH=32768"  # the change worth making
# Environment="OLLAMA_NUM_PARALLEL=2"      # only with evidence of queuing, and
                                           # only with the context cap above
```

`OLLAMA_MAX_LOADED_MODELS=2` is the floor for any appliance that ships an
embedding model alongside a chat model — see the `DEFAULT_CHAT_MODEL` comment in
`backend/apps/api/src/configuration.ts`, which makes the same point about the
default chat model being a floor everyone pays for.

## Re-measuring

The harnesses used here are throwaway but the method is not:

1. Unload everything, then measure embedding throughput at batch 1/8/32/64.
2. Cold-load the chat model, record TTFT; repeat warm three times.
3. With chat resident, re-run the embedding batches and check `ollama ps` shows
   **both** models.
4. Re-measure chat TTFT. If it matches the warm figure, co-residency held; if it
   matches the cold figure, the fit estimate evicted the chat model.

Step 4 is the whole test. A cap of 2 that silently degrades to serial swapping
looks exactly like a cap of 1 from the application's side, and only `ollama ps`
plus that TTFT comparison tells them apart.
