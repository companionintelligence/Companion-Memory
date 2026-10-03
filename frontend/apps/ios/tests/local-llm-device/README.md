# On-device LLM bench

Measures the iOS on-device LLM stack on a **physical iPhone**: how much of the context window is spent
before the user says anything, what a tool-calling turn costs, how good the answer after a
`knowledge_search` call is, and how far a window can be raised before the phone says no.

It exists because the Simulator is not evidence. `tests/local-llm-pure` checks the logic on a Mac;
this checks the engine, with the real LiteRT-LM binary, the real model files and the real chat
template, on the hardware the numbers are about.

## What it is

A small standalone app (`LocalLLMBench`, bundle id `com.companionintelligence.app.llmbench`) generated
by XcodeGen from [`project.yml`](project.yml). It compiles **the app's own sources by reference** —
`LocalLLMEngine`, `LocalLLMPolicy` (the `ToolResultShaper`), `LocalLLMModels`, `LocalLLMStreaming`,
`CompanionIntentTools`, `CompanionIntentClient`, and the vendored LiteRT-LM wrapper — plus the bench's
own `Sources/`. No Capacitor, no Pods, no web build: about a minute to build.

- **The appliance is faked on the loopback interface** (`FakeAppliance.swift`), so the *real*
  `CompanionIntentClient` and the *real* tools run: manifest, MCP `initialize`, `tools/call`. What it
  returns comes from `Fixtures.swift`, a **synthetic** person's memory shaped like the appliance's
  hydrated `knowledge.search` hits (the real field set, UUIDv7 ids, `type`/`link` on every hit). Nothing
  in it is real data, which is why it can be committed and why two runs are comparable.
- **A plan is a JSON list of cells.** A cell is one measurement: a model, a window, a way of shaping the
  tool result, a sampler, a question — see `BenchCell` in `Sources/BenchModel.swift`. The app runs the
  cells one after another and appends one JSON line per cell to `Documents/bench/results-<plan>.jsonl`,
  flushed as it goes. A cell that kills the process (jetsam is the interesting case) is recorded as
  `crashed` on the next launch; finished cells are skipped, so a plan can be relaunched until it is done.
- **Two ways in.** `RawSession` opens an engine and conversation exactly the way `LocalLLMEngine` does but
  exposes what an experiment varies (seed, system text, thinking on the tool continuation, a per-request
  output cap, constrained decoding) and what it needs to read (the KV-cache token count, the model's own
  tokenizer, the rendered prompt). `mode: prod` runs a cell through the real `LocalLLMEngine` — that is
  the end-to-end check of whatever the experiments chose.
- **Scoring is mechanical and only a first filter.** `Scoring.swift` checks that an answer is non-empty,
  carries a fact of the question, names nothing only a decoy hit contains, and is clean (no control
  markers, no foreign-script letters, no runaway repetition). Every answer is kept verbatim in the
  results; `summarize.py --answers` prints them so the filter can be checked by reading.

## Running it

Needs Xcode, `xcodegen` (`brew install xcodegen`), the xcframework
(`../../ios/App/Frameworks/fetch-clitertlm-xcframework.sh`), a paired iPhone in Developer Mode, and
the two catalog model files (the pinned Hugging Face files `LocalLLMModels.swift` names, 344 MB and
1.6 GB).

```bash
./bench.sh build                       # Release, for the connected iPhone
./bench.sh install                     # a separate bundle id: no installed Companion app is touched
./bench.sh models ~/Downloads/models   # copies the two .litertlm files into the bench's container
python3 plans.py dev1 dev2             # writes plans/dev1.json, plans/dev2.json (see `plans.py list`)
./bench.sh run plans/dev1.json         # launches, waits, relaunches after a crash, pulls the results
python3 summarize.py results/results-dev2.jsonl --by note
python3 summarize.py results/results-dev2.jsonl --answers --where prompt=p1 --limit 10
```

The phone has to be **unlocked to launch** the app (install and file copies work locked; `bench.sh`
waits out a locked phone) and then has to **stay awake and plugged in**: the app keeps the screen on
(`isIdleTimerDisabled`), and a long plan is minutes to hours of sustained CPU. The bench waits while the
device is `serious` or `critical` and records the thermal state with every cell, because a hot phone
measures the governor, not the model.

## Reading the results

Each line of `results-<plan>.jsonl` is a cell and what it measured:

| field | what it is |
|---|---|
| `load` | engine load time, footprint before/after, `os_proc_available_memory` after, and the **peak** footprint and least headroom sampled every 50 ms while loading |
| `turns[].toolCalls[]` | which tool the model called, its arguments, the result's size raw and shaped, in bytes and in **the model's own tokens**, and `kvAtCall` — the KV-cache tokens at the moment of the call |
| `turns[].kvBefore/kvAfter` | the KV-cache token count (prefill + decode) straight from the runtime |
| `turns[].postToolFirstChunkMs` | how long the model took to start answering once the tool's result was handed back: the prefill of that result |
| `turns[].peak` | the highest footprint and least headroom during the turn |
| `turns[].answer`, `thought`, `raw` | what the app would show, the reasoning, and every chunk before `ReplyAssembler` touched it |
| `account` | `account` mode: the rendered preface's tokens with no system and no tools, system only, and system plus tools; each tool's declaration |
| `renders` | `render` mode: the text the chat template makes of a user message and of a tool message (as a string, as an object) |

`plans.py` builds the plans the PR measured (`think`, `shape`, `window`, `qwen25`, …); every stage's
docstring says what question it asks.

## Simulator

Everything here also builds for the Simulator (`xcodebuild … -destination 'platform=iOS Simulator,…'
ARCHS=arm64`), and it is a convenient place to develop a plan, because a cell takes seconds and nothing
overheats. **It is not a source of numbers**: `os_proc_available_memory` is 0 there, the footprint is the
Mac process's, the speed is the Mac's, and nothing about LiteRT-LM on the Simulator is promised.

## Limits

- One device, one OS version, one thermal condition per run. The plan files record none of that; the
  results do (`device`, `before`, `after`, `cooledSeconds`).
- The sampler seed does not make a run reproducible (two cells with the same seed answer differently), so
  rates need replicates; the stages use 3–8.
- The corpus is small and English. It is a harness for comparing settings, not a benchmark of the model.
