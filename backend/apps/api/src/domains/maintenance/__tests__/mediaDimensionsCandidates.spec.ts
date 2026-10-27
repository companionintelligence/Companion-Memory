import { STAGE_IDS, stageVersion } from '@ci/domains/pipeline';

import {
  MEDIA_DIMENSIONS_STAGE_ID,
  MEDIA_DIMENSIONS_STAGE_VERSION,
  countMediaDimensionsCandidates,
} from '../mediaDimensionsCandidates';

/**
 * The two values `mediaDimensionsCandidates.ts` has to hold as literals, held to
 * the pipeline's own. A plain unit spec on purpose: `test:unit` leaves out
 * `*.integration.spec.ts`, so a pin living there would not run without a
 * database. The count itself is exercised against real Postgres in
 * `mediaDimensionsCandidates.integration.spec.ts`.
 */
describe('mediaDimensionsCandidates', () => {
  it('names the real media-dimensions stage', () => {
    expect(MEDIA_DIMENSIONS_STAGE_ID).toBe(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS);
  });

  it('compares against the stage version the pipeline runs', () => {
    expect(MEDIA_DIMENSIONS_STAGE_VERSION).toBe(stageVersion(STAGE_IDS.ENRICH_MEDIA_DIMENSIONS));
  });

  it('binds the user, the stage and its version, in that order', async () => {
    const query = jest.fn(async () => [{ count: '7' }]);

    await expect(countMediaDimensionsCandidates({ query } as never, 'user-1')).resolves.toBe(7);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('p.stage_version >= $3'), [
      'user-1',
      MEDIA_DIMENSIONS_STAGE_ID,
      MEDIA_DIMENSIONS_STAGE_VERSION,
    ]);
  });
});
