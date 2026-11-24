import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { ActionService } from '@ci/domains/intelligence';
import { KnownPlacesService, type KnownPlaceCandidate } from '@ci/domains/memory';

import { CONFIRM_HOME_ACTION_KEY, HOME_QUESTION_ID } from './homeConfirm';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HomeAskSnapshot {
  labeled: boolean;
  candidates: KnownPlaceCandidate[];
}

/**
 * One writer for home identity: selector persist, Q&A, and the feed action all
 * call {@link KnownPlacesService.updateKnownPlace} with `kind: 'home'`.
 */
@Injectable()
export class HomeConfirmService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly knownPlaces: KnownPlacesService,
    private readonly actionService: ActionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HomeConfirmService.name);
  }

  async snapshot(context: UserServiceContext): Promise<HomeAskSnapshot> {
    const [homes, candidates] = await Promise.all([
      this.knownPlaces.getKnownPlaces(context, 'home'),
      this.knownPlaces.buildKnownPlaces(context),
    ]);

    return { labeled: homes.length > 0, candidates };
  }

  candidateOptions(candidates: KnownPlaceCandidate[]): Array<{ id: string; label: string }> {
    return candidates
      .filter((candidate) => candidate.locationId)
      .slice(0, 6)
      .map((candidate) => ({ id: candidate.locationId as string, label: candidate.label }));
  }

  /**
   * The place a yes/no "Is <label> home?" names, and the one a bare "yes"
   * confirms: the candidate {@link KnownPlacesService} tagged `home`, or null.
   *
   * There is deliberately no fallback to the busiest candidate. The tag needs
   * evidence that recurs over weeks, so a user without it has no `home`
   * candidate, and the busiest place is exactly the unsupported guess the tag
   * refuses to make. On the reference corpus that is a calendar Location built
   * from travel, or an unnamed cell labelled "Unknown place".
   */
  topHomeCandidate(candidates: KnownPlaceCandidate[]): KnownPlaceCandidate | null {
    return candidates.find((candidate) => candidate.kind === 'home') ?? null;
  }

  /**
   * Enqueue at most one undismissed `confirm_home` action while home is
   * unlabeled. It asks "Is <label> home?" about the `home` candidate when there
   * is one, and otherwise "Which of these places is home?" over the named
   * candidates. With neither, there is nothing to ask.
   */
  async ensureAction(context: UserServiceContext): Promise<void> {
    const { labeled, candidates } = await this.snapshot(context);
    if (labeled || candidates.length === 0) {
      return;
    }

    const top = this.topHomeCandidate(candidates);
    const options = this.candidateOptions(candidates);
    if (!top && options.length === 0) {
      return;
    }

    const existing = (await this.dataSource.query(
      `
      SELECT id::text AS id
        FROM ci.actions
       WHERE user_id = $1
         AND dismissed = FALSE
         AND source = 'suggestion'
         AND metadata->>'key' = $2
       LIMIT 1
      `,
      [context.userId, CONFIRM_HOME_ACTION_KEY],
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      return;
    }

    const prompt = top ? `Is ${top.label} home?` : 'Which of these places is home?';

    await this.actionService.create(context, {
      title: 'Confirm home',
      text: prompt,
      priority: 2,
      source: 'suggestion',
      metadata: {
        key: CONFIRM_HOME_ACTION_KEY,
        questionId: HOME_QUESTION_ID,
        candidateIds: options.map((option) => option.id),
        candidateLabel: top?.label,
        locationId: top?.locationId,
      },
    });
  }

  /**
   * Persist a home confirmation. Returns null when the response is a decline
   * or cannot be resolved to a place.
   */
  async confirmFromResponse(
    context: UserServiceContext,
    response: unknown,
    candidates: KnownPlaceCandidate[] = [],
  ): Promise<boolean> {
    if (this.isDecline(response)) {
      return false;
    }

    const pool = candidates.length > 0 ? candidates : (await this.snapshot(context)).candidates;
    const picked = this.resolvePlace(response, pool);
    if (!picked) {
      this.logger.warn('Home confirm had no resolvable place', {
        userId: context.userId,
        response: typeof response === 'string' ? response : typeof response,
      });

      return false;
    }

    await this.knownPlaces.updateKnownPlace(context, {
      label: picked.label,
      kind: 'home',
      locationId: picked.locationId,
      coordinates: { lat: picked.lat, lng: picked.lng },
      confidence: Math.max(picked.confidence, 0.8),
      source: 'manual',
    });

    return true;
  }

  private resolvePlace(response: unknown, candidates: KnownPlaceCandidate[]): KnownPlaceCandidate | null {
    if (typeof response !== 'string') {
      return null;
    }

    const trimmed = response.trim().toLowerCase();
    if (UUID_RE.test(response.trim())) {
      const id = response.trim();

      return (
        candidates.find((candidate) => candidate.locationId === id) ?? {
          locationId: id,
          label: 'Home',
          kind: 'home',
          lat: Number.NaN,
          lng: Number.NaN,
          eventCount: 0,
          sampleEvents: [],
          confidence: 0.8,
          presenceDays: 0,
          presenceNights: 0,
        }
      );
    }

    if (trimmed === 'yes' || trimmed === 'home') {
      return this.topHomeCandidate(candidates);
    }

    const byLabel = candidates.find(
      (candidate) => candidate.label.trim().toLowerCase() === trimmed.toLowerCase(),
    );

    return byLabel ?? null;
  }

  private isDecline(response: unknown): boolean {
    if (typeof response !== 'string') {
      return false;
    }

    const trimmed = response.trim().toLowerCase();

    return trimmed === 'no' || trimmed === 'not_sure' || trimmed === 'other' || trimmed === 'work';
  }
}
