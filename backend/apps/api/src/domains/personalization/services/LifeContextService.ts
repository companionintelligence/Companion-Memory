import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { UserContextService } from '@ci/domains/memory';

import { ContextPromptService } from './ContextPromptService';
import { PersonalizationService } from './PersonalizationService';

export interface LifeOptimizationContext {
  readonly trustMode: string;
  readonly dossierBlock: string;
  readonly recentGraphDeltas: unknown[];
  readonly pendingContextPrompts: number;
  readonly insightVolumeMultiplier: number;
}

@Injectable()
export class LifeContextService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly userContextService: UserContextService,
    private readonly personalizationService: PersonalizationService,
    private readonly contextPromptService: ContextPromptService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(LifeContextService.name);
  }

  async buildForUser(userId: string): Promise<LifeOptimizationContext> {
    const profile = await this.personalizationService.getProfile(userId);
    const userCtx = await this.userContextService.getUserContextForLLM(userId);
    const dossierBlock = userCtx ? this.userContextService.formatContextForSystemPrompt(userCtx) : '';

    type DeltaRow = { delta: unknown };
    const deltaRows = (await this.dataSource.query(
      `
      -- There is no \`delta\` column, and there never was: GraphDeltaWriter
      -- writes the change decomposed across change_type / changed_fields /
      -- change_source (see GraphDeltaWriter.ts), so this SELECT threw on every
      -- call and buildForUser could never return. Rebuilding the object here
      -- keeps the caller's shape while naming columns that exist.
      SELECT jsonb_build_object(
        'entityId', entity_id,
        'entityType', entity_type,
        'relationshipType', relationship_type,
        'changeType', change_type,
        'changedFields', changed_fields,
        'changeSource', change_source,
        'changedAt', changed_at
      ) AS delta
      FROM ci.graph_deltas
      WHERE owner_user_id = $1::uuid
      ORDER BY changed_at DESC
      LIMIT 20;
      `,
      [userId],
    )) as DeltaRow[];

    const pendingContextPrompts = await this.contextPromptService.countPending(userId);

    return {
      trustMode: profile.trustMode,
      dossierBlock,
      recentGraphDeltas: deltaRows.map((r) => r.delta),
      pendingContextPrompts,
      insightVolumeMultiplier: profile.insightVolumeMultiplier,
    };
  }

  async hasNoveltySinceLastRun(userId: string, workType: string): Promise<boolean> {
    type Row = { changed: boolean };
    const rows = (await this.dataSource.query(
      `
      WITH last_run AS (
        SELECT COALESCE(MAX(completed_on), '1970-01-01'::timestamptz) AS ts
        FROM pgboss.job
        WHERE state IN ('completed', 'failed', 'cancelled')
          AND data->>'name' = 'smart.rotation.work'
          AND data->>'workType' = $2
          AND data->>'userId' = $1::text
      )
      SELECT EXISTS (
        -- Three of these four column names were wrong, and because Postgres
        -- reports only the FIRST unknown column the errors masked each other:
        -- fixing gd.user_id merely revealed gd.created_at, and so on. The real
        -- columns are graph_deltas(owner_user_id, changed_at) — owner, not
        -- changed_by, because "did MY graph change" is about whose graph it is,
        -- not who edited it — and communications.time. Only the events branch
        -- was already correct.
        SELECT 1 FROM ci.graph_deltas gd, last_run lr
        WHERE gd.owner_user_id = $1::uuid AND gd.changed_at > lr.ts
        UNION ALL
        SELECT 1 FROM ci.communications c, last_run lr
        WHERE c.user_id = $1::uuid AND c.time > lr.ts
        UNION ALL
        SELECT 1 FROM ci.events e, last_run lr
        WHERE e.user_id = $1::uuid AND e.created_at > lr.ts
      ) AS changed;
      `,
      [userId, workType],
    )) as Row[];

    return rows[0]?.changed ?? true;
  }
}
