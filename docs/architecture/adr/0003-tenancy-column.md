# ADR-0003: Canonical Tenancy Column (`user_id`)

| Field         | Value                    |
|---------------|--------------------------|
| **Status**    | Accepted                 |
| **Date**      | 2026-08-08               |
| **Author(s)** | Schema consolidation     |
| **Reviewers** | TBD                      |

## Context

CI-Server tables scope rows to a user with two spellings:

- `user_id` — timeline and capture tables (`events`, `content`, `communications`,
  `browser_activity`, `capture_events`, `position`, …)
- `owner_user_id` — the knowledge graph (`entities`, `relationships`), where it is
  the *only* tenancy column.

Both mean the same tenancy boundary. Dual names accumulate in join SQL and make
it unclear which spelling new tables should use.

> **Correction, verified against the schema on 2026-08-19.** This ADR originally
> listed `inventory`, `product_models`, `receipts` and `object_observations` as
> `owner_user_id` tables. They are not — each carries **both** columns, and they do
> not mean the same thing there:
>
> - `user_id UUID NOT NULL … ON DELETE CASCADE` is the tenancy column, and it is what
>   every read scopes on (`ItemService`, `ProductModelService`, `ReceiptService`,
>   `ObjectObservationService` all filter `user_id`).
> - `owner_user_id UUID … ON DELETE SET NULL` is nullable and means *auto-detected
>   owner of the physical thing* — a domain fact, not a tenancy boundary. It is what
>   the provenance-triple and natural-key unique indexes on those tables are keyed on
>   (`inventory_source_triple_uniq`, `receipts_source_triple_uniq`, …), and
>   `20260803223013` notes that a future shared catalog would arrive as
>   `owner_user_id IS NULL` rows.
>
> Services set both to the caller on create, which is why the two look
> interchangeable in practice. They are not interchangeable in the indexes.

## Decision

**`user_id` is the canonical tenancy column** for new tables and for
documentation of the product data model.

**`owner_user_id` is retained** on `ci.entities` and `ci.relationships`, where it is
the tenancy column, and on `ci.objects` and the commerce tables (`ci.product_models`,
`ci.receipts`, `ci.receipt_line_items`, `ci.object_observations`, `ci.object_identifiers`),
which share that provenance pattern. Renaming it is out of scope for this consolidation
wave — the blast radius (indexes, TypeORM entities, raw SQL, importer contracts) is large
for no runtime win.

**On inventory/commerce, `owner_user_id` stays for a different reason**: it is not a
second spelling of tenancy there but a distinct fact (auto-detected owner), and the
provenance-triple unique indexes are keyed on it. Do not "consolidate" it away.

Application code may treat `user_id` and `owner_user_id` as synonyms for the same
owner *on the graph tables*. On inventory/commerce, scope reads on `user_id`.

## Consequences

- New tables default to `user_id`.
- The graph keeps `owner_user_id` until a dedicated rename wave.
- Inventory/commerce keep both columns, with different meanings; a write that sets one
  and not the other will either escape user scoping or break idempotency.
- Docs and ADRs prefer the phrase "user-scoped" over debating column names.
