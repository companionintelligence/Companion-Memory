/**
 * The write stamp: a hybrid logical clock reading (`updatedAt`, `updatedAtCounter`, `originId`) that
 * every Space, Collection and Resource Metadata object carries and that orders writes.
 *
 * It is NOT in the text of PWS v0.5. The Interop Alliance's reference server emits it and its
 * conformance suite asserts it on ordinary Metadata objects, and the open Replication companion
 * (spec PR #93) is where it is expected to be specified, so it is built here as an extension and
 * documented as one (`docs/pws.md`). Clients must ignore members they do not know; these are additive.
 *
 *   updatedAt          RFC 3339 date-time at millisecond precision
 *   updatedAtCounter   a non-negative integer that ticks when the millisecond did not advance
 *   originId           which store minted the stamp: [A-Za-z0-9_-]{1,64}
 *
 * The triple is the record's order key, so a later write of the same record sorts strictly after an
 * earlier one even inside one millisecond or across a clock that steps backwards. The `ETag` is a
 * separate validator and moves on every write.
 *
 * The clock lives in memory. A durable store must start it from the highest stamp it holds
 * (`observe`), or a restart could mint a stamp that sorts before one already stored.
 */
import { randomBytes } from 'node:crypto';

export const ORIGIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface Stamp {
  updatedAt: string;
  updatedAtCounter: number;
  originId: string;
}

export class StampClock {
  private lastMs = 0;
  private counter = 0;

  constructor(readonly originId: string = randomBytes(6).toString('base64url')) {
    if (!ORIGIN_ID.test(originId)) {
      throw new TypeError('originId must match [A-Za-z0-9_-]{1,64}');
    }
  }

  /** The stamp for a write happening at `now`. Never repeats, and never sorts before the last one. */
  tick(now: Date): Stamp {
    const ms = now.getTime();
    if (ms > this.lastMs) {
      this.lastMs = ms;
      this.counter = 0;
    } else {
      // The millisecond did not advance (or the wall clock stepped back): keep the later time and tick.
      this.counter += 1;
    }
    return {
      updatedAt: new Date(this.lastMs).toISOString(),
      updatedAtCounter: this.counter,
      originId: this.originId,
    };
  }

  /** Moves the clock past a stamp read from storage, so the next `tick` sorts after it. */
  observe(stamp: Stamp): void {
    const ms = Date.parse(stamp.updatedAt);
    if (ms > this.lastMs || (ms === this.lastMs && stamp.updatedAtCounter >= this.counter)) {
      this.lastMs = ms;
      this.counter = stamp.updatedAtCounter;
    }
  }
}

/** Negative, zero or positive: the order of two stamps by (time, counter, origin). */
export function compareStamps(a: Stamp, b: Stamp): number {
  const byTime = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (byTime !== 0) {
    return byTime;
  }
  const byCounter = a.updatedAtCounter - b.updatedAtCounter;
  if (byCounter !== 0) {
    return byCounter;
  }
  return a.originId === b.originId ? 0 : a.originId < b.originId ? -1 : 1;
}
