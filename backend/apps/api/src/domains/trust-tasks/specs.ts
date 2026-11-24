import type { ZodType } from 'zod/v3';

import type { ParsedTypeUri } from './typeUri';

/**
 * What this box knows about a Trust Task specification it serves — SPEC §7.3's declarations, as data.
 *
 * The declarations a consumer ACTS on are fields here: whether `proof` is required, whether
 * `recipient` is, whether the document must carry `issuedAt`, whether the task is consequential (and so
 * subject to the duplicate-execution rule of §7.2 item 11), and the payload schemas. The rest —
 * side-effect class, exposure, retention — are descriptive (§7.3 items 13, 14, 18): they inform and
 * render, and a consumer that gates on them determines the authoritative values from the handler it is
 * about to invoke. They are carried here so the same record that drives the pipeline also drives the
 * published specification documents and the docs that quote them.
 */

export type Requirement = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';

export interface TaskSpecification {
  /** The bare Type URI: the name of this version of this specification. */
  readonly typeUri: string;
  readonly slug: string;
  readonly version: string;
  readonly title: string;
  /** The framework release (`MAJOR.MINOR.PATCH`) the specification targets. */
  readonly targetFrameworkVersion: string;
  readonly status: 'draft' | 'candidate' | 'standard';
  readonly parties: { readonly issuer: Requirement; readonly recipient: Requirement };
  /** §4.8.3: audience-free by design. The default, and almost always the right value, is false. */
  readonly bearer: boolean;
  /** §7.3 item 8, per variant. */
  readonly proof: { readonly request: Requirement; readonly response: Requirement };
  /** §7.3 item 17: REQUIRED for every consequential task. */
  readonly issuedAt: Requirement;
  readonly sideEffects: { readonly level: 'none' | 'mutating' | 'destructive'; readonly rationale: string };
  readonly exposure: {
    readonly discloses: 'none' | 'metadata' | 'secret';
    readonly ingests: 'none' | 'metadata' | 'personal' | 'secret';
    readonly actsAsSubject: boolean;
    readonly rationale: string;
  };
  readonly retention: { readonly class: 'transient' | 'exchange' | 'durable'; readonly rationale: string };
  /**
   * §7.2 item 11's escape hatch: the operation is naturally idempotent, so executing it twice is
   * indistinguishable from once in every effect the recipient exposes. Disapplies the duplicate guard.
   * A specification MUST NOT say this merely to avoid implementing the rule.
   */
  readonly repeatSafe: boolean;
  /** §7.3 item 6: a non-normative statement of what successful execution achieves between the parties. */
  readonly outcome: string;
  /**
   * §7.3 item 19: for every free-text member of the payload, who reads it, whether it is kept, and whether
   * it is trusted. A member is named by its path in the payload.
   */
  readonly freeText: readonly {
    readonly member: string;
    readonly maxLength: number;
    readonly reader: string;
    readonly retained: boolean;
    readonly trusted: boolean;
  }[];
  /**
   * §7.3 item 21: the largest serialized request document, in bytes of its UTF-8 JSON text as received,
   * `proof` included, that a consumer serving the task accepts. Enforced BEFORE anything is hashed, so it
   * bounds what a caller can make this box compute.
   */
  readonly maxDocumentBytes: number;
  /** The request payload schema. Closed: an unrecognized member is `malformedRequest`. */
  readonly request: ZodType<unknown>;
  /** The `#response` payload schema; absent for a fire-and-forget task. */
  readonly response?: ZodType<unknown>;
  /** §9.4: the external protocol this specification carries, when it carries one. */
  readonly carries?: {
    readonly protocol: string;
    readonly version: string;
    readonly reference: string;
    readonly operation: string;
  };
}

/**
 * §3, "Consequential Trust Task": a task whose successful execution the consumer cannot silently undo.
 * It is consequential when it mutates or destroys, discloses a secret, or acts as the subject. This
 * restates the definition over the declared values; a handler that knows better wins.
 */
export function isConsequential(spec: TaskSpecification): boolean {
  return (
    spec.sideEffects.level !== 'none' || spec.exposure.discloses === 'secret' || spec.exposure.actsAsSubject
  );
}

export type SpecLookup =
  { readonly found: TaskSpecification } | { readonly missing: 'unsupportedType' | 'unsupportedVersion' };

/** The Type URI with its version stripped: the identity of a specification across versions. */
function familyOf(bare: string, version: string): string {
  return bare.slice(0, bare.length - version.length);
}

/** The specifications this box serves, found by exact Type URI (§6.1: a Type URI is a name). */
export class SpecRegistry {
  private readonly byUri = new Map<string, TaskSpecification>();

  private readonly families = new Set<string>();

  register(spec: TaskSpecification): this {
    if (this.byUri.has(spec.typeUri)) {
      throw new Error(`Trust Task specification registered twice: ${spec.typeUri}`);
    }

    this.byUri.set(spec.typeUri, spec);
    this.families.add(familyOf(spec.typeUri, spec.version));

    return this;
  }

  /**
   * `unsupportedVersion` when the specification is known at some other version, `unsupportedType` when
   * it is not known at all (§8.3). The two differ only in what they tell the sender to try next.
   */
  find(parsed: ParsedTypeUri): SpecLookup {
    const spec = this.byUri.get(parsed.bare);
    if (spec !== undefined) {
      return { found: spec };
    }

    return {
      missing: this.families.has(familyOf(parsed.bare, parsed.version))
        ? 'unsupportedVersion'
        : 'unsupportedType',
    };
  }

  list(): TaskSpecification[] {
    return [...this.byUri.values()];
  }
}
