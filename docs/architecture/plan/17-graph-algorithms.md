# 17 — Graph Algorithms (rustworkx)

> **Status:** draft &nbsp;•&nbsp; **Phase:** P2
>
> Productionize the `spike/rustworkx` work — ego graph, Steiner tree, subgraph — into real retrieval primitives that the memory model uses.

---

## 1. Summary

`spike/rustworkx` already adds ego graph (partial), Steiner tree, subgraph routes, and JWT-aware retrieval. These aren't curiosities — they're the **right primitives** for a memory store:

- **Ego graph** = "everything related to entity X within N hops" → the heart of "show me what you know about Sarah".
- **Steiner tree** = minimum subgraph connecting a set of nodes → "how are these three people connected?".
- **Subgraph** = a query result rendered as a graph slice → the SPA force-graph view.

These belong in the canonical memory API, not in a spike.

## 2. Current state

`spike/rustworkx` has:
- Subgraph route
- JWT authentication
- Mock data with island nodes
- Steiner tree
- Ego graph (noted as "does not seem to completely work")

The implementation appears to call out to a Rust process using `rustworkx`. Production-grade alternatives include Postgres AGE Cypher (already installed), `pgRouting`, or a TypeScript graph library — but `rustworkx` for the hard algorithms is fine if isolated.

## 3. Target state

### 3.1 API additions

```graphql
type Query {
  egoGraph(entityId: ID!, hops: Int = 2, kinds: [String!]): GraphSlice!
  steinerTree(entityIds: [ID!]!): GraphSlice!
  shortestPath(fromId: ID!, toId: ID!): [Edge!]
  subgraph(rootId: ID!, filter: SubgraphFilter): GraphSlice!
  ranking: GraphRankingQueries!     # see 3.2
}
type GraphRankingQueries {
  centralEntities(kind: String, top: Int = 20): [RankedEntity!]!
  communities(method: String = "louvain"): [Community!]!
}
```

### 3.2 Ranking, communities

Add two utility queries:
- `centralEntities` — PageRank/betweenness on the user's graph. Useful for "who matters most to me" / "what topics dominate".
- `communities` — Louvain clusters; the SPA can color the force-graph by community.

### 3.3 Memory-model integration

[03 memory model](03-memory-model.md) consolidation uses these primitives:
- **Procedural detection**: look at ego graphs around routine candidates.
- **Reflective generation**: find dense subgraphs where the user's preferences diverge from actions.
- **Cold-storage pruning**: ego nodes with degree 0 outside their immediate neighborhood become facts.

### 3.4 Implementation choice

Three options:

| Option | Pros | Cons |
|---|---|---|
| Apache AGE Cypher (already in DB) | Zero new infra | Cypher dialect surface; performance for Steiner tree TBD |
| In-process rustworkx via Python sidecar | Mature algorithms | Cross-process call overhead |
| TypeScript native (e.g., `graphology`) | Same process | Less optimized for large graphs |

Recommendation: **AGE-first** for traversal; **Python sidecar with rustworkx** for Steiner/PageRank/Louvain (called from Temporal during nightly consolidation, results cached as derived edges).

## 4. Branch disposition

| Branch | Action |
|---|---|
| `spike/rustworkx` | Salvage: ego graph (finish), Steiner tree, subgraph; rewrite within the production module. Don't merge the spike as-is. |

## 5. Phased steps

| # | Increment |
|---|---|
| 1 | Implement ego graph via AGE Cypher in `domains/graph/services/GraphService` |
| 2 | Add subgraph + shortest path |
| 3 | Python sidecar for Steiner tree + PageRank + Louvain |
| 4 | Cache PageRank scores on entities (`importance` boost on top of [03](03-memory-model.md)) |
| 5 | Consolidation uses these primitives |
| 6 | SPA: communities coloring + "who matters most" view |

## 6. Risks

| Risk | Mitigation |
|---|---|
| Ego graph queries too slow on big graphs | Hop cap; degree cap per hop; cache per (entity, hops, kinds). |
| Steiner tree is NP-hard | Already approximated by rustworkx; bound N; offer "give me a path" fallback. |
| Sidecar adds operational complexity | Optional; pure AGE path works for v1. |

## 7. Eval / acceptance

- "Who is the most central person in my life?" returns a stable top-10 across runs.
- "How do these three contacts connect?" returns a small subgraph in < 200ms p95 for graphs up to 100k nodes.
- The SPA force-graph uses community coloring.
