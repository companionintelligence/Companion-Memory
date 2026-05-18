# 14 — Observability (OpenTelemetry)

> **Status:** draft &nbsp;•&nbsp; **Phase:** P6
>
> Merge the in-flight OTel branch, then layer per-domain spans, recall-quality metrics, and an audit log dashboard.

---

## 1. Summary

Today: `LoggerService` only. No traces, no metrics, no error reporting beyond stdout. The `audit` domain is barely used. When an MCP-connected agent silently mis-recalls, there's no way to trace from MCP call → tool → DB query → embedding lookup → answer.

## 2. Current state

- `LoggerService` in `common/logging`.
- An in-flight branch `codex/add-opentelemetry-client-support` (commit `1fb3259b feat: add opentelemetry logging export`).
- A copilot variant `copilot/add-opentelemetry-client-support` (the duplicate is itself a signal — pick one).

## 3. Target state

### 3.1 Layers

| Layer | Signal | Tool |
|---|---|---|
| Trace | Per-request spans across API, Temporal workers, HBPE, Summary, MCP | OTel SDK → OTLP → Jaeger/Tempo |
| Metrics | Latency, throughput, error rate per route, per tool, per skill | OTel metrics → Prometheus scrape |
| Logs | Structured JSON | OTel logs (already in flight) |
| Recall quality | Recall@k drift over time | Custom: writes from [12-evals](12-memory-evals.md) |
| Audit | Per-actor reads/writes | `auth_denials`, `tool_invocations`, `skill_invocations`, `consent_receipts` |

### 3.2 Standard span attributes

- `actor.id`, `actor.kind`
- `route` or `mcp.tool` or `graphql.field`
- `db.statement` (truncated)
- `tool.name`, `tool.provider`
- `llm.provider`, `llm.model`, `llm.task`, `llm.tokens_in/out`, `llm.cost_usd_micro`
- `memory.kind`, `memory.match_score` (for recall spans)

### 3.3 Cross-process trace propagation

Temporal workflows accept incoming W3C traceparent on activity scheduling so the trace continues into HBPE / Summary workers.

### 3.4 Dashboards

| Dashboard | Panels |
|---|---|
| **Twin health** | API p95, error rate, queue depth, sync lag per provider |
| **Agent activity** | Calls/skills/tools per agent per day; denials |
| **Memory quality** | recall@k, forgetting-precision, eval drift |
| **LLM spend** | Tokens & cost by provider/model/task/actor |
| **Ingest** | Rows/sec by device; DLQ size |

Ships as a JSON Grafana bundle in `infrastructure/observability/`.

### 3.5 Audit log dashboard in SPA

A user-facing "what did I and my agents do" view, backed by the existing audit tables (and the new ones from [09](09-privacy-consent.md) and [06](06-tool-registry-expansion.md)).

## 4. Branch disposition

| Branch | Action |
|---|---|
| `codex/add-opentelemetry-client-support` | **Merge** as the foundation. |
| `copilot/add-opentelemetry-client-support` | Compare; pick whichever is closer to OTel best-practice; **archive the other.** |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | Merge OTel branch; standardize attributes |
| 2 | Propagate traces into Temporal workers |
| 3 | Span every domain entry point (controllers, GraphQL resolvers, MCP tools) |
| 4 | Metrics: route, tool, skill, LLM |
| 5 | Optional: bundled Jaeger/Prometheus stack in compose profile `observability` |
| 6 | Grafana dashboard bundle |
| 7 | SPA audit page |

## 6. Risks

| Risk | Mitigation |
|---|---|
| OTel adds overhead | Use batch span processor; sampling at 10% in production; 100% in dev. |
| PII leaks via spans | Span attribute redaction list (e.g., never log raw `db.statement` bound values). |
| Two competing OTel branches | Pick one in week 1 and archive the other. |

## 7. Eval / acceptance

- A single agent call traces end-to-end: MCP → tool → DB → embed → response.
- LLM spend dashboard shows per-skill cost.
- Eval drift dashboard reflects PR-by-PR scores.
- The SPA shows the user's own activity log including agent calls.
