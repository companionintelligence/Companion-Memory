import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { GraphIngestService } from '@ci/domains/graph';
import { CONTACT_STAGED_TYPE, stagedNaturalKey } from '@ci/domains/import';
import type { PersonalizationDecision, TrustMode } from '@ci/domains/personalization';

import {
  ALL_TRUST_MODES,
  personalizationWithTrustMode,
} from '../../../__tests__/support/personalizationTrustMode';
import {
  EntityTypeAuditService,
  KEYED_AS_CONTACT_SCORE,
  UNPROVEN_KEY_SCORE,
} from '../EntityTypeAuditService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE TRUST DIAL CAN ACTUALLY ANSWER, ASKED OF THE DIAL ITSELF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The audit used to count `skipped` proposals — findings "the trust dial
 * refused to file at all" — and the counter was structurally always 0: for the
 * call shape this service uses (`graph_entity`, `hasUserInput: true`)
 * `PersonalizationService` has no path to `skip`. A reader of `skipped: 0`
 * concluded the dial had approved everything, when the dial had never been able
 * to say no.
 *
 * A stub is what let that stand, so there is none here. The dial is the real
 * {@link personalizationWithTrustMode} service; only the two reads that fetch a
 * trust mode off the self Person are doubled. The DataSource IS doubled — the
 * SQL is the integration spec's job — so these assertions are about the gate
 * and nothing else:
 *
 *  1. Every reachable decision FILES the proposal. There is no suppression to
 *     count, in any mode, at either score.
 *  2. `auto` appears exactly where a `hands_off` appliance has pre-authorised
 *     the retype, and nowhere else.
 *  3. Swept across the whole confidence range, the answers this call can get
 *     are `review` and — in `hands_off` only — `auto`. Never `skip`. If that
 *     ever stops being true, the audit needs a suppression counter again, and
 *     this is the test that says so.
 */

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

const USER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
/** A Google Voice SMS short code that landed as a Person — the thing being found. */
const SHORT_CODE_NAME = '262966';

/** The key the pre-fix contact path minted, which is what scores 0.9. */
const KEYED_AS_CONTACT = GraphIngestService.linkedIdFor(
  stagedNaturalKey(CONTACT_STAGED_TYPE, null, SHORT_CODE_NAME) as string,
);
/** Any other key: how the row was minted is unproven, so it scores 0.5. */
const UNPROVEN_KEY = randomUUID();

interface AuditRun {
  service: EntityTypeAuditService;
  /** One entry per INSERT the run issued, so "filed" means a row, not a return value. */
  writes: string[];
}

/**
 * The service with its SQL doubled: one candidate in the window, a free target
 * coordinate, an empty person index.
 */
function auditRun(trustMode: TrustMode | null, linkedId: string): AuditRun {
  const writes: string[] = [];
  const dataSource = {
    query: async (sql: string, params: unknown[] = []) => {
      const text = sql.trimStart();

      if (text.startsWith('INSERT INTO ci.entity_type_proposals')) {
        writes.push(String(params[1]));

        return [];
      }

      if (text.includes('FROM ci.entities e')) {
        return [
          {
            entityId: ENTITY,
            ownerUserId: USER,
            entityType: 'Person',
            name: SHORT_CODE_NAME,
            linkedTable: 'import:google_voice',
            linkedId,
            reachableIdentifiers: 0,
            reachableProperties: false,
          },
        ];
      }

      // The occupancy probe: nothing sits on the proposed coordinate.
      if (text.includes('FROM ci.entities t')) {
        return [];
      }

      return [{ vectors: 0, embeddings: 0, index_skips: 0, pipeline_state: 0 }];
    },
  } as unknown as DataSource;

  return {
    service: new EntityTypeAuditService(dataSource, personalizationWithTrustMode(trustMode), noopLogger),
    writes,
  };
}

describe('EntityTypeAuditService: the trust gate files, it does not suppress', () => {
  const scores = [
    ['keyed as contact', KEYED_AS_CONTACT, KEYED_AS_CONTACT_SCORE],
    ['unproven key', UNPROVEN_KEY, UNPROVEN_KEY_SCORE],
  ] as const;

  describe.each([...ALL_TRUST_MODES])('trust mode %s', (trustMode) => {
    it.each(scores)('files the finding (%s)', async (_label, linkedId, score) => {
      const run = auditRun(trustMode, linkedId);
      const result = await run.service.audit(USER);

      expect(result.findings).toBe(1);
      // The claim `proposed` now makes: the dial chooses the autonomy a
      // proposal carries, never whether it is written.
      expect(result.proposed).toBe(result.findings);
      expect(run.writes).toEqual([ENTITY]);
      expect(result.records[0].score).toBe(score);
    });
  });

  it('reports no counter for a decision the dial cannot reach', async () => {
    const result = await auditRun('cautious', KEYED_AS_CONTACT).service.audit(USER);

    // `skipped: 0` was indistinguishable from "the dial approved everything",
    // and it could never be anything else. It is gone rather than softened.
    expect(Object.keys(result).sort()).toEqual(['examined', 'findings', 'proposed', 'records', 'userId']);
  });

  it('records auto only where a hands_off appliance pre-authorised the retype', async () => {
    const autonomies: Array<[TrustMode | null, string, string]> = [];

    for (const trustMode of ALL_TRUST_MODES) {
      for (const [label, linkedId] of scores) {
        const result = await auditRun(trustMode, linkedId).service.audit(USER);

        autonomies.push([trustMode, label, result.records[0].autonomy]);
      }
    }

    expect(autonomies).toEqual([
      [null, 'keyed as contact', 'review'],
      [null, 'unproven key', 'review'],
      ['cautious', 'keyed as contact', 'review'],
      ['cautious', 'unproven key', 'review'],
      ['balanced', 'keyed as contact', 'review'],
      ['balanced', 'unproven key', 'review'],
      // 0.9 clears hands_off's 0.7 threshold; 0.5 is below it, and that is the
      // whole point of UNPROVEN_KEY_SCORE.
      ['hands_off', 'keyed as contact', 'auto'],
      ['hands_off', 'unproven key', 'review'],
    ]);
  });
});

describe('what the real dial can answer for a graph_entity backed by imported user data', () => {
  it.each([...ALL_TRUST_MODES])('never skips, in any mode, at any confidence (%s)', async (trustMode) => {
    const dial = personalizationWithTrustMode(trustMode);
    const answers = new Set<PersonalizationDecision>();

    // The whole range, not just the two scores the audit produces: the counter
    // this replaced claimed to cover confidences nobody had tried.
    for (let step = 0; step <= 20; step += 1) {
      answers.add(
        await dial.decideAction(USER, {
          kind: 'graph_entity',
          confidence: step / 20,
          hasUserInput: true,
        }),
      );
    }

    expect([...answers].sort()).toEqual(trustMode === 'hands_off' ? ['auto', 'review'] : ['review']);
  });
});
