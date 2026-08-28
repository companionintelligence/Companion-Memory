import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { UserService } from '@ci/domains/user';

import { AnomalyEngine } from '../anomaly/AnomalyEngine';
import { CorrelationEngine } from '../correlation/CorrelationEngine';
import type { MetricAnomaly } from '../entities/MetricAnomalyEntity';
import { SuggestionEngine } from '../suggest/SuggestionEngine';

/**
 * Standing scan: correlations → anomalies → suggestions, per user.
 * Failures for one engine or one user do not abort the rest.
 */
@Injectable()
export class DerivationScanService {
  constructor(
    private readonly correlationEngine: CorrelationEngine,
    private readonly anomalyEngine: AnomalyEngine,
    private readonly suggestionEngine: SuggestionEngine,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DerivationScanService.name);
  }

  async scanUser(context: UserServiceContext, timezone = 'UTC'): Promise<void> {
    try {
      await this.correlationEngine.scan(context, timezone);
    } catch (err) {
      this.logger.error(
        `Correlation scan failed for user ${context.userId}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    let anomalies: MetricAnomaly[] = [];
    try {
      anomalies = await this.anomalyEngine.scan(context, timezone);
    } catch (err) {
      this.logger.error(
        `Anomaly scan failed for user ${context.userId}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    try {
      await this.suggestionEngine.propose(context, anomalies, timezone);
    } catch (err) {
      this.logger.error(
        `Suggestion propose failed for user ${context.userId}`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async scanAll(): Promise<void> {
    const users = await this.userService.findAllOnboarded();
    this.logger.log('Running derivation scan', { users: users.length });

    for (const user of users) {
      await this.scanUser({ userId: user.id }, user.timezone || 'UTC');
    }
  }
}
