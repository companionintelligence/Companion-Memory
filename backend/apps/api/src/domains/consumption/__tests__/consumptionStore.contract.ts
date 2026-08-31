import type { ConsumptionStore } from '../ConsumptionStore';

/**
 * The suite BOTH backends must pass.
 *
 * This file is the deliverable of #2365 as much as the Postgres table is. An
 * interface with one tested implementation is the old `Map` with more ceremony;
 * what makes the abstraction worth anything is that the two implementations are
 * held to the same observable behaviour, including under contention.
 *
 * UMA races 32 concurrent callers at each single-use artifact for the same
 * reason. A store whose `claimOnce` is atomic only when called serially will
 * pass every test written serially and then admit a replay the first time two
 * requests arrive together.
 *
 * Exported as a function rather than written as a `describe` so the Postgres
 * spec can skip itself when no migrated database is reachable, without the
 * in-memory spec skipping too.
 */
export function itBehavesLikeAConsumptionStore(
  name: string,
  makeStore: () => Promise<ConsumptionStore> | ConsumptionStore,
  /** A fresh key per test, so a shared database does not leak state between runs. */
  freshKey: () => string,
): void {
  describe(`${name} — ConsumptionStore contract`, () => {
    let store: ConsumptionStore;

    beforeEach(async () => {
      store = await makeStore();
    });

    describe('takeWindow', () => {
      it('grants up to the limit and then refuses', async () => {
        const key = freshKey();
        const take = () => store.takeWindow({ key, now: 1_000, windowMs: 60_000, max: 3 });

        expect((await take()).allowed).toBe(true);
        expect((await take()).allowed).toBe(true);
        expect((await take()).allowed).toBe(true);
        expect((await take()).allowed).toBe(false);
      });

      it('reports how long until the next attempt would be allowed', async () => {
        const key = freshKey();
        await store.takeWindow({ key, now: 1_000, windowMs: 60_000, max: 1 });

        const refused = await store.takeWindow({ key, now: 21_000, windowMs: 60_000, max: 1 });

        expect(refused.allowed).toBe(false);
        // The first hit ages out 60s after it landed, i.e. 40s from now.
        expect(refused.retryAfterMs).toBe(40_000);
      });

      it('lets the window slide — an aged-out hit stops counting', async () => {
        const key = freshKey();
        await store.takeWindow({ key, now: 1_000, windowMs: 60_000, max: 1 });

        expect((await store.takeWindow({ key, now: 61_001, windowMs: 60_000, max: 1 })).allowed).toBe(true);
      });

      it('keys are independent — one caller cannot spend another’s allowance', async () => {
        const a = freshKey();
        const b = freshKey();
        await store.takeWindow({ key: a, now: 1_000, windowMs: 60_000, max: 1 });

        expect((await store.takeWindow({ key: b, now: 1_000, windowMs: 60_000, max: 1 })).allowed).toBe(true);
      });

      /**
       * THE TEST THE `Map` WOULD HAVE PASSED AND A NAIVE UPSERT WOULD NOT.
       *
       * Thirty-two callers race for three slots. Exactly three may win. A
       * read-modify-write that is not serialized per key grants more, because
       * every racer reads the same pre-state.
       */
      it('grants exactly `max` when 32 callers race', async () => {
        const key = freshKey();

        const results = await Promise.all(
          Array.from({ length: 32 }, () => store.takeWindow({ key, now: 1_000, windowMs: 60_000, max: 3 })),
        );

        expect(results.filter((r: { allowed: boolean }) => r.allowed)).toHaveLength(3);
      });
    });

    describe('claimOnce', () => {
      it('returns true for the first claim and false thereafter', async () => {
        const key = freshKey();

        expect(await store.claimOnce({ key, now: 1_000, expiresAtMs: 61_000 })).toBe(true);
        expect(await store.claimOnce({ key, now: 1_000, expiresAtMs: 61_000 })).toBe(false);
      });

      it('lets a key be reclaimed once its window has closed', async () => {
        // Correct for a replay nonce: past its expiry the signature it protects
        // is refused by the freshness window anyway, so holding the key forever
        // buys nothing and grows the table without bound.
        const key = freshKey();
        await store.claimOnce({ key, now: 1_000, expiresAtMs: 61_000 });

        expect(await store.claimOnce({ key, now: 61_001, expiresAtMs: 121_000 })).toBe(true);
      });

      it('keys are independent', async () => {
        const a = freshKey();
        const b = freshKey();
        await store.claimOnce({ key: a, now: 1_000, expiresAtMs: 61_000 });

        expect(await store.claimOnce({ key: b, now: 1_000, expiresAtMs: 61_000 })).toBe(true);
      });

      /**
       * THE ONE THAT MATTERS. A nonce cache that is atomic only when called
       * serially admits a replay the first time two requests arrive together —
       * which is exactly how a replay attack is delivered.
       */
      it('admits exactly one of 32 racing claims', async () => {
        const key = freshKey();

        const results = await Promise.all(
          Array.from({ length: 32 }, () => store.claimOnce({ key, now: 1_000, expiresAtMs: 61_000 })),
        );

        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });
  });
}
