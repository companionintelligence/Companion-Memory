/**
 * Server-side plaintext indexing, as far as this server does it: the `unique` claim.
 *
 * A Collection may declare `plaintext.indexes`. Each entry names an attribute the server reads out
 * of stored Resources, and `unique: true` makes the `(name, value)` pair a claim that no two
 * Resources in the Collection may share. Only `source: content` is implemented: the attribute is
 * the top-level member of that name in a JSON Resource's stored content. `source: custom`
 * (reading the Resource's annotations) is accepted as a declaration but cannot be enforced, so a
 * `unique` claim over it is refused with `unsupported-operation` rather than silently ignored.
 *
 * The value compared is the member's JSON text, so `1` and `"1"` are different values. A Resource
 * that lacks the member, or is not JSON, holds no value and never conflicts. Uniqueness is checked
 * after authorization and inside the write's transaction, so two concurrent claimants cannot both
 * win, and a Resource re-asserting its own value never conflicts with itself.
 */
import { isJsonMediaType } from './http';
import type { PlaintextIndex, PlaintextIndexDeclaration, ResourceRecord } from './models';
import { PwsError } from './problems';
import type { PwsTx } from './store';
import { normalizeIndexes } from './validate';

const PAGE = 500;

export function extractIndexed(
  index: PlaintextIndex,
  contentType: string,
  bytes: Uint8Array,
): string | undefined {
  if (index.source !== 'content' || !isJsonMediaType(contentType)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    // an own property only: an index named `__proto__` or `constructor` must not read the prototype
    const value = Object.hasOwn(parsed, index.name)
      ? (parsed as Record<string, unknown>)[index.name]
      : undefined;

    return value === undefined || value === null ? undefined : JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Throws `unsupported-operation` for a `unique` claim this server cannot enforce. */
export function assertEnforceable(indexes: readonly PlaintextIndexDeclaration[] | undefined): void {
  for (const index of normalizeIndexes(indexes ?? [])) {
    if (index.unique && index.source !== 'content') {
      throw new PwsError(
        'unsupported-operation',
        `A unique claim over "${index.name}" with source "${index.source}" cannot be enforced by this server.`,
      );
    }
  }
}

async function allResources(tx: PwsTx, spaceId: string, collectionId: string): Promise<ResourceRecord[]> {
  const all: ResourceRecord[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await tx.listResources(spaceId, collectionId, {
      limit: PAGE,
      ...(after !== undefined ? { after } : {}),
    });
    all.push(...page.items);
    const last = page.items[page.items.length - 1];
    if (!page.hasMore || !last) {
      return all;
    }

    after = last.id;
  }
}

/** A write of `candidate` must not take a unique value another Resource already holds. */
export async function assertWriteIsUnique(
  tx: PwsTx,
  args: {
    spaceId: string;
    collectionId: string;
    indexes: readonly PlaintextIndexDeclaration[] | undefined;
    candidate: { id: string; contentType: string; bytes: Uint8Array };
  },
): Promise<void> {
  const unique = normalizeIndexes(args.indexes ?? []).filter(
    (index) => index.unique && index.source === 'content',
  );
  if (unique.length === 0) {
    return;
  }

  const others = (await allResources(tx, args.spaceId, args.collectionId)).filter(
    (r) => r.id !== args.candidate.id,
  );
  for (const index of unique) {
    const value = extractIndexed(index, args.candidate.contentType, args.candidate.bytes);
    if (value === undefined) {
      continue;
    }

    if (others.some((other) => extractIndexed(index, other.contentType, other.bytes) === value)) {
      throw new PwsError('id-conflict', `The value of "${index.name}" is already held by another Resource.`);
    }
  }
}

/** Promoting an attribute to unique over Resources that already collide is `id-conflict`. */
export async function assertDeclarationHolds(
  tx: PwsTx,
  args: { spaceId: string; collectionId: string; indexes: readonly PlaintextIndexDeclaration[] | undefined },
): Promise<void> {
  const unique = normalizeIndexes(args.indexes ?? []).filter(
    (index) => index.unique && index.source === 'content',
  );
  if (unique.length === 0) {
    return;
  }

  const resources = await allResources(tx, args.spaceId, args.collectionId);
  for (const index of unique) {
    const seen = new Set<string>();
    for (const resource of resources) {
      const value = extractIndexed(index, resource.contentType, resource.bytes);
      if (value === undefined) {
        continue;
      }

      if (seen.has(value)) {
        throw new PwsError(
          'id-conflict',
          `Existing Resources already share a value of "${index.name}", so it cannot be declared unique.`,
        );
      }

      seen.add(value);
    }
  }
}
