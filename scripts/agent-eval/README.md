# Multi-turn chat agent eval

The thing being scored is the conversation trace: each user turn, the tools
the model called, the arguments, the tool results, and the answer that
followed. A wrong answer after the right lookup is a different failure from
a wrong answer after the wrong lookup, and the report keeps those apart.

```
user message
  -> model
  -> memory / graph / places / calendar tools
  -> tool results
  -> model
  -> response
  -> next user turn
```

This sits next to `scripts/benchmark`, which scores memory retrieval on a
synthetic persona. This package drives the chat agent (`POST /api/llm/generate`)
on a running Companion Memory.

## What a case looks like

```json
{
  "id": "tools_personal_place_lookup",
  "capability": "tools",
  "conversation": [
    {"role": "user", "content": "Which of my saved places are in Manhattan?"}
  ],
  "expected": {
    "should_use": ["places"],
    "must_not_use": ["messaging"],
    "answer_contains": ["a name you are willing to treat as the answer"]
  }
}
```

`should_use` and `must_not_use` accept a family or an exact tool name.

| Family | Tools |
| --- | --- |
| memory | `knowledge.search`, `memory.recall`, `memory.remember`, `memory.forget`, `knowledge.preferences` |
| graph | `people.find`, `people.relationships` |
| places | `places.find`, `places.next` |
| calendar | `calendar.findEvents` |
| messaging | `messaging.listMessages`, `messaging.listChats`, `messaging.send` |

`should_use` means every listed spec was used. `should_use_any` means at least
one. `answer_contains` means every phrase appears. `answer_contains_any` means
one of them does. `admit_unknown` passes when the answer says the fact is not
in memory. `argument_contains` checks substrings of the tool arguments.
`anywhere` applies the same tool checks across the whole thread, which is how
a lookup on turn 1 still counts after a follow-up.

`turns` is optional and lines up with `conversation`. A turn object overrides
the case-level `expected` for that turn. The case-level `expected` applies to
the last turn when that turn has no checks of its own.

Capabilities: `memory`, `graph`, `ontology`, `tools`, `conversation`, `robustness`.

## Run

```bash
cd scripts/agent-eval
export CI_SERVER_URL=http://127.0.0.1:8642
export CI_SERVER_TOKEN=<api key or session token>
export CI_EVAL_MODEL=qwen3.5:9b   # optional; otherwise the server default

python -m agent_eval validate
python -m agent_eval run --out reports/latest.md
```

`run` opens a new thread per case, sends each user message, waits until
generation is idle, reads the stored messages, and writes
`reports/latest.md` plus `reports/latest.json`. The process exits non-zero
when any deterministic check fails. Reports are gitignored.

Score a trace you already saved, without calling the model:

```bash
python -m agent_eval score trace.json case.json
```

Add another directory of cases (repeat the flag). Personal cases belong
outside this repo:

```bash
python -m agent_eval run \
  --cases cases \
  --cases "$HOME/devel/agent-eval-personal/cases"
```

A case with `"needs_owner": true` is skipped until the answer key is filled
and the flag is removed. `--score-incomplete` scores them anyway.

## Metrics

The report counts each of these on its own. It does not average them.

| Metric | What it measures |
| --- | --- |
| tool_selection | a required tool or family was called |
| tool_avoidance | a forbidden tool or family was not called |
| tool_arguments | a required substring was in the arguments |
| retrieval | every tool call has a stored result |
| answer | required phrases are in the final text of that turn |
| hallucination | a forbidden phrase is absent, or an unknown fact was admitted |
| run | the thread finished and has one trace turn per user message |

## Tests

```bash
cd scripts/agent-eval
python -m unittest discover -s tests
```

## Personal answer keys

The cases in `cases/` do not depend on anyone's memory. Questions whose right
answer is a fact from your memory go in a directory outside the git tree, with
`needs_owner` until you have written the answer you would accept. The intake
for that set is `agent-eval-personal/INTAKE.md` next to the ci-server checkout.
