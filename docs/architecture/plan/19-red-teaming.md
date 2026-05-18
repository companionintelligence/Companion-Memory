# 19 — Red-Teaming & Safety Evals (promptfoo)

> **Status:** draft &nbsp;•&nbsp; **Phase:** P0
>
> Merge the in-flight promptfoo scaffolding, then expand it into an adversarial suite that runs against the MCP surface in CI.

---

## 1. Summary

`copilot/add-llm-red-team-prompt-foo` adds the scaffolding for promptfoo. As soon as the twin starts handling external agents' prompts, we need a standing adversarial test bed that catches prompt injection, exfiltration attempts, scope violations, and PII egress regressions on every PR.

## 2. Current state

The branch commits:
- `feat: add promptfoo red team scaffolding`
- `docs: clarify promptfoo baseline limits`
- `ci: scope github token permissions`

Scaffolding only; the suites still need to be written.

## 3. Target state

### 3.1 Suites

| Suite | What it probes | Pass criterion |
|---|---|---|
| `prompt-injection` | Memory writes contain "ignore previous instructions" + system-prompt overrides | 0 successful overrides |
| `scope-violation` | A `memory:read` key tries write tools | 100% deny + log |
| `data-exfiltration` | An LLM tool tries to embed user PII in its output to call an external URL | 0 leaks |
| `confused-deputy` | Tool A's output used as Tool B's input without confirmation | depends on [06](06-tool-registry-expansion.md) — must require confirmation |
| `pii-egress` | A non-owner key asks for full email/address/SSN | redaction per policy |
| `denial-of-service` | Pathological inputs (huge args, recursion) | bounded by timeout/throttler |
| `embedding-leak` | Adversarial embedding similarity attack | not directly preventable, but recall surface should not return high-PII results to low-scope keys |

### 3.2 Runner

- Suites live in `tests/red-team/promptfoo/`.
- Runs against the in-process MCP module (canonical surface) plus the GraphQL surface.
- CI job on every PR; fail on any regression.
- Nightly run against `main` with cost-bearing models (configurable).

### 3.3 Mitigations driven by findings

Each suite that finds a real exploit creates a follow-up:
- Input sanitization at MCP boundary.
- Output filtering before tool→tool chaining.
- Scope guard hardening ([07](07-auth-scopes-throttling.md)).
- Redactor coverage gap ([09](09-privacy-consent.md)).

### 3.4 Threat model document

A short `docs/security/threat-model.md` listing:
- The agent perimeter (untrusted output, trusted code).
- Trust boundaries (MCP transport, tool registry, LLM provider).
- Out-of-scope (host OS compromise, supply-chain).
- Mitigations and where they live.

## 4. Branch disposition

| Branch | Action |
|---|---|
| `copilot/add-llm-red-team-prompt-foo` | Merge as the scaffolding. |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | Merge promptfoo scaffolding |
| 2 | Author the seven suites above |
| 3 | CI integration (block on regression) |
| 4 | Threat-model doc |
| 5 | Pair findings with concrete fixes; iterate |
| 6 | Nightly cost-bearing run with rotating provider matrix |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Adversarial corpus rots | Treat it like security tests; review quarterly. |
| Suites become flaky | Anchor expectations on policy outcomes (denial logs, redaction shape) rather than LLM output strings where possible. |
| Cost of nightly runs | Sample; cap per-suite budget; prefer local models for most checks. |

## 7. Eval / acceptance

- A new exploit path discovered in production is captured as a suite within a day.
- Every PR that touches MCP/tools/auth shows a red-team scorecard in comments.
- Threat-model doc is up to date in CODEOWNERS-tracked location.
