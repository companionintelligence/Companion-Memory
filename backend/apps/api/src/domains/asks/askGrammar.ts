import { z } from 'zod';

import type { AnswerForm, AskQuery } from './types';

/**
 * The DCQL-subset ask grammar (ROADMAP Epic 2).
 *
 * The ask is modelled on OID4VP 1.0's **DCQL** — the only Final standard in this
 * space — rather than on a datastore query. That choice is the security property:
 * a DCQL query names the CLAIMS the asker wants, so it can never address the
 * responder's storage layout, table names, or record ids. The responder's box
 * decides what satisfies a claim.
 *
 * The same object is used three ways, which is why it is worth formalizing:
 *   1. what the asker sends,
 *   2. what the owner's grant is matched and reviewed against,
 *   3. what is replayed in the audit log.
 *
 * Everything here is **hostile input**: every field is bounded, unknown keys are
 * stripped, and the parsed result is the only shape allowed downstream.
 */

/** Ask archetypes — each a distinct disclosure surface. Mirrors peers/protocol.ts. */
export const ASK_ARCHETYPES = ['relationship', 'content', 'availability', 'attribute', 'identity'] as const;
export type AskArchetype = (typeof ASK_ARCHETYPES)[number];

/** Answer form each archetype may produce. The archetype fixes the disclosure surface. */
const ARCHETYPE_FORM: Readonly<Record<AskArchetype, AnswerForm>> = {
  relationship: 'boolean',
  content: 'existence',
  availability: 'attribute',
  attribute: 'attribute',
  identity: 'identity',
};

export function formForArchetype(archetype: AskArchetype): AnswerForm {
  return ARCHETYPE_FORM[archetype];
}

/**
 * A claim query: the DCQL `claims` entry. `path` names a claim in CI's claim
 * vocabulary (NOT a storage path); `values` optionally constrains it.
 */
export const claimQuerySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(60)
      // Dotted claim names only — no wildcards, no traversal, no injection surface.
      .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, 'claim path must be dotted lowercase'),
    values: z.array(z.string().max(200)).max(10).optional(),
  })
  .strict();

export type ClaimQuery = z.infer<typeof claimQuerySchema>;

/** One credential-query analogue: an archetype plus the claims wanted from it. */
export const askQuerySpecSchema = z
  .object({
    /** Stable id so `querySets` can reference this entry. */
    id: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, 'id must be url-safe'),
    archetype: z.enum(ASK_ARCHETYPES),
    /** Coarse data class, canonicalized by the grant evaluator. */
    dataClass: z.string().max(60).optional(),
    claims: z.array(claimQuerySchema).max(10).optional(),
    /** Inclusive time window; both bounds required together when present. */
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict()
  .refine((spec) => (spec.from == null) === (spec.to == null), {
    message: 'from and to must be supplied together',
  })
  .refine((spec) => spec.from == null || spec.to == null || spec.from <= spec.to, {
    message: 'from must not be after to',
  });

export type AskQuerySpec = z.infer<typeof askQuerySpecSchema>;

/**
 * DCQL `credential_sets` analogue: "satisfy any one of these option groups".
 * Lets an asker express *"photos of the lake trip OR the calendar entry for it"*
 * without sending two asks the owner must review separately.
 */
export const askQuerySetSchema = z
  .object({
    options: z
      .array(z.array(z.string().max(40)).min(1).max(5))
      .min(1)
      .max(5),
    required: z.boolean().optional(),
  })
  .strict();

/** The complete grammar for one ask. */
export const askGrammarSchema = z
  .object({
    /** The natural-language question, shown to both sides. Never executed. */
    prompt: z.string().min(1).max(500),
    queries: z.array(askQuerySpecSchema).min(1).max(5),
    querySets: z.array(askQuerySetSchema).max(3).optional(),
    /** Why the asker wants this; shown to the owner, never used to widen scope. */
    purpose: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((grammar, ctx) => {
    const ids = grammar.queries.map((q) => q.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'query ids must be unique' });
    }

    // Every id referenced by a set must exist, or the set silently matches nothing.
    const known = new Set(ids);
    for (const set of grammar.querySets ?? []) {
      for (const option of set.options) {
        for (const id of option) {
          if (!known.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `querySets references unknown query id: ${id}`,
            });
          }
        }
      }
    }
  });

export type AskGrammar = z.infer<typeof askGrammarSchema>;

/**
 * Parse and bound an untrusted ask. Throws {@link z.ZodError} on anything
 * off-contract — callers surface that as a 400, never as a partial execution.
 */
export function parseAskGrammar(raw: unknown): AskGrammar {
  return askGrammarSchema.parse(raw);
}

/**
 * Project the grammar onto the flat {@link AskQuery} the consent evaluator and
 * executor already consume.
 *
 * The FIRST query is the primary one: its archetype becomes `queryType` and its
 * class becomes `dataClass`, which is what the grant is matched against. Later
 * queries are alternatives carried in `filters` for the executor — they cannot
 * widen the grant match, so an asker can't smuggle a second, unconsented class
 * past the gate by appending it.
 */
export function toAskQuery(grammar: AskGrammar): AskQuery {
  const [primary, ...alternatives] = grammar.queries;

  return {
    queryType: primary.archetype,
    dataClass: primary.dataClass,
    prompt: grammar.prompt,
    filters: {
      claims: primary.claims ?? [],
      ...(primary.from != null ? { from: primary.from, to: primary.to } : {}),
      ...(grammar.purpose != null ? { purpose: grammar.purpose } : {}),
      ...(alternatives.length > 0 ? { alternatives } : {}),
      ...(grammar.querySets != null ? { querySets: grammar.querySets } : {}),
    },
  };
}

/**
 * The strictest data class the grammar touches, for ceiling evaluation.
 *
 * A multi-query ask is only as safe as its most sensitive part, so the ceiling
 * must be computed over EVERY query — not just the primary one that drove grant
 * matching. Returns every distinct class named.
 */
export function dataClassesIn(grammar: AskGrammar): string[] {
  return [...new Set(grammar.queries.map((q) => q.dataClass).filter((c): c is string => c != null))];
}
