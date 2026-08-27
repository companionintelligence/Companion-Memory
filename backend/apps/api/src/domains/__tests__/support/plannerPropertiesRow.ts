/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE `ci.entities.properties` BLOB, WITH BOTH WAYS OF WRITING IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two settings services write leaves of the same `planner` sub-object on the
 * self Person: `planner.trust_mode` (PersonalizationService) and
 * `planner.image_description_enabled` (ImageDescriptionPreferenceService).
 * They live in different domains, so neither spec may import the other's
 * service; each one instead drives its own service and plays the *other*
 * writer against this shared row.
 *
 * The row models the two write shapes exactly as Postgres applies them:
 *
 * - {@link shallowMerge} is `properties || :patch::jsonb` — a TOP-LEVEL merge,
 *   so a patch carrying a whole `planner` object replaces the stored one
 *   outright, including leaves the caller never meant to touch.
 * - {@link setLeaves} is `jsonb_set(properties, '{planner,<leaf>}', …, true)` —
 *   it replaces only the leaf it names.
 *
 * Writes land on the live row, the way an UPDATE does; {@link snapshot} is the
 * application-level read a service does through `findById` and then holds
 * while another writer commits. That gap is the whole defect: the read is
 * stale, the write is not.
 *
 * This is a fake, not a database. It cannot prove the SQL is valid — see
 * `domains/memory/services/__tests__/jsonbLeafPatch.test.ts` for the generated
 * expression, and note that neither is a substitute for two real concurrent
 * transactions.
 */
export type PlannerLeafWrite = { path: string[]; value: unknown };

export class FakePropertiesRow {
  properties: Record<string, unknown>;

  constructor(
    initial: Record<string, unknown> = { planner: { trust_mode: 'balanced', source: 'onboarding' } },
  ) {
    this.properties = JSON.parse(JSON.stringify(initial)) as Record<string, unknown>;
  }

  get planner(): Record<string, unknown> {
    return (this.properties.planner ?? {}) as Record<string, unknown>;
  }

  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.properties)) as Record<string, unknown>;
  }

  /** `properties || :patch::jsonb` */
  shallowMerge(patch: Record<string, unknown>): void {
    this.properties = {
      ...this.properties,
      ...(JSON.parse(JSON.stringify(patch)) as Record<string, unknown>),
    };
  }

  /** `jsonb_set(properties, path, value, true)`, once per leaf. */
  setLeaves(leaves: PlannerLeafWrite[]): void {
    for (const { path, value } of leaves) {
      let cursor = this.properties;
      for (const segment of path.slice(0, -1)) {
        const next = cursor[segment];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) {
          cursor[segment] = {};
        }

        cursor = cursor[segment] as Record<string, unknown>;
      }

      cursor[path[path.length - 1]!] = value ?? null;
    }
  }
}

export type FakePersonService = {
  /** Every `propertiesPatch` sent through the top-level shallow merge. */
  patchCalls: Array<Record<string, unknown>>;
  /** Every leaf list sent through `patchPropertyLeaves`. */
  leafCalls: PlannerLeafWrite[][];
  /** Resolvers for `findById` calls held open, so a read can be made stale on purpose. */
  pendingReads: Array<() => void>;
  /** Duck-typed stand-in; cast to `never` at the constructor call site. */
  service: Record<string, unknown>;
};

/**
 * A PersonService double over `row`.
 *
 * `findById` snapshots the row and then parks until its resolver in
 * {@link FakePersonService.pendingReads} is called, which is how a spec makes a
 * service hold a stale read across somebody else's commit.
 */
export function fakePersonServiceOver(row: FakePropertiesRow, selfId: string): FakePersonService {
  const patchCalls: Array<Record<string, unknown>> = [];
  const leafCalls: PlannerLeafWrite[][] = [];
  const pendingReads: Array<() => void> = [];

  const service = {
    findById: async () => {
      const properties = row.snapshot();
      await new Promise<void>((resolve) => pendingReads.push(resolve));

      return { id: selfId, properties };
    },
    patch: async (_context: unknown, _id: string, data: { propertiesPatch?: Record<string, unknown> }) => {
      patchCalls.push(data.propertiesPatch ?? {});
      row.shallowMerge(data.propertiesPatch ?? {});

      return { id: selfId, properties: row.snapshot() };
    },
    patchPropertyLeaves: async (_context: unknown, _id: string, leaves: PlannerLeafWrite[]) => {
      leafCalls.push(leaves);
      row.setLeaves(leaves);

      return { id: selfId, properties: row.snapshot() };
    },
  };

  return { patchCalls, leafCalls, pendingReads, service };
}

/** Let queued microtasks/IO callbacks run so parked `findById` calls have registered. */
export async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
