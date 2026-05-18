# 09 — Privacy, Redaction, Consent

> **Status:** draft &nbsp;•&nbsp; **Phase:** P5
>
> Add field-level PII tagging, per-agent sharing policies, redaction at egress, and consent receipts.

---

## 1. Summary

The twin holds extremely sensitive data: messages, finances, locations, health metrics. Once external agents can read it, "all-or-nothing" access is unacceptable. We need:

1. **PII detection at ingest** — every property gets tagged.
2. **Sharing policies** — per-agent allow/deny path patterns + retention.
3. **Redaction at egress** — applied for any non-owner reader.
4. **Consent receipts** — the user can see (and revoke) what each agent has accessed.

## 2. Current state

- No PII tagging.
- No sharing policy model.
- The `audit` domain exists but is minimally used.
- Embeddings are computed over raw text — sharing the embedding service is fine, but if we ever push embeddings to an external store, PII leaks.

## 3. Target state

### 3.1 PII tagger

A pass in the ingest pipeline that walks `properties` JSONB and annotates leaves with PII class:

```json
{
  "email": { "$value": "j@x.com", "$pii": ["email"] },
  "ssn":   { "$value": "***-**-1234", "$pii": ["ssn"], "$redaction": "preserved-last4" }
}
```

Implementation:
- Library: `microsoft/presidio` style detection (regex + lightweight ML) — runs locally, no external call.
- Classes: `email, phone, ssn, address, location_precise, location_coarse, financial_account, health_metric, name_first, name_last, name_full, child_name, dob`.
- Run at write time in `PromoteService` and on user-authored entities at insert time.

### 3.2 Sharing policy

```sql
CREATE TABLE agent_access_policies (
  id uuid PRIMARY KEY,
  agent_actor_id uuid NOT NULL,    -- the agent's actor row (see 10)
  scope_pattern jsonb NOT NULL,    -- {allow: [...], deny: [...]}
  pii_egress jsonb NOT NULL,       -- {email:'masked', address:'block', ...}
  retention_days int,
  enabled bool DEFAULT true,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE consent_receipts (
  id uuid PRIMARY KEY,
  policy_id uuid REFERENCES agent_access_policies(id),
  agent_actor_id uuid,
  resource text,               -- 'entity:<id>', 'thread:<id>', 'tool:<name>'
  fields_accessed text[],
  redactions_applied jsonb,
  at timestamptz DEFAULT now()
);
```

`scope_pattern.allow/deny` examples:
- `allow: ["memory.semantic.*", "summary.daily.*"]`
- `deny: ["memory.episodic.health.*", "entity.properties.financial_*"]`

### 3.3 Redaction at egress

A `Redactor` middleware runs after every read controller/resolver/MCP tool, BEFORE response serialization. Pseudocode:

```
for path, value in walk(response):
    pii_classes = pii_tags_for(path)
    rule = policy.pii_egress for first match in pii_classes
    apply(rule, value)   # mask | redact | block | preserve-last-N
```

For the owner (session JWT), policy is "preserve" by default — the user sees their own data raw.

### 3.4 Consent receipts

Every external-agent read produces a row in `consent_receipts`. The SPA has an "Agent access log" page:

```
[2026-05-18 14:22] claude-code  read summary.daily(2026-05-17) — 3 fields
[2026-05-18 14:23] claude-code  read thread #abc — name_first masked
[2026-05-18 14:30] openclaw     denied: memory.episodic.health.* (policy)
```

The user can revoke a policy from this view; revocation takes effect within one request.

### 3.5 Embedding hygiene

- Embeddings stay local.
- If a future change ever pushes embeddings off-box, a `pii_safe` flag on `embeddings` controls eligibility, and PII-tagged sources are excluded by default.

## 4. Branch disposition

| Branch | Role |
|---|---|
| (none direct) | Build on top of [10 multi-actor](10-multi-actor.md) and [08 provenance](08-provenance-lineage.md). |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | PII tagger as a `PromoteService` step; backfill via Temporal nightly |
| 2 | `agent_access_policies` + `consent_receipts` migrations |
| 3 | `Redactor` middleware applied to all controllers + GraphQL responses + MCP tool returns |
| 4 | UI: per-agent policy editor + access log + revocation |
| 5 | Default policies per agent kind (Claude Code / Cowork / OpenClaw / Codex starter templates) |
| 6 | "Right to be forgotten" hard-delete with cascade through `derived_from` edges |

## 6. Risks

| Risk | Mitigation |
|---|---|
| PII tagger over-redacts and breaks agent usefulness | Per-actor egress tunable; user can relax for specific agents. |
| PII tagger misses cases | Multiple passes (regex + classifier); flag uncertain matches for user review. |
| Performance hit on every read | Tags computed once at write; redaction is a JSON walk with a precompiled rule set. |
| Receipt table grows unbounded | Retention default 90 days; aggregate older entries to weekly summaries. |

## 7. Eval / acceptance

- Connecting Claude Code with default policy: agent can read summaries but receives masked email addresses by default.
- Revoking access mid-session: next tool call returns `403` with `policy_revoked`.
- A PII-tagged ingest run from Google Contacts produces redacted output to external agents and clean output to the SPA.
- "Right to be forgotten" deletes the source episodic and prunes derived semantics that have no other support.
