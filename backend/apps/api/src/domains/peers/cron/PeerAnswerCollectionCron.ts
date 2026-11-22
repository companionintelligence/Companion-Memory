import { Injectable } from '@nestjs/common';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { OutboundAskService } from '../services/OutboundAskService';

/**
 * Every ten minutes. An answer the other person approved reaches the asker
 * within that, without anyone pressing anything; "Check for an answer" on the
 * ask is there for anyone who does not want to wait.
 */
export const PEER_ANSWER_COLLECTION_CRON = '0 */10 * * * *';

/**
 * Drives {@link OutboundAskService.collectOpenAnswers}: the asker's half of the
 * return path, which was written and tested and called by nothing, so an ask
 * the other side's owner reviewed and approved never came back.
 */
@Injectable()
export class PeerAnswerCollectionCron {
  constructor(
    private readonly outboundAskService: OutboundAskService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerAnswerCollectionCron.name);
  }

  // `exclusive`: a run slowed by unreachable peers must not stack with the next.
  @Cron(PEER_ANSWER_COLLECTION_CRON, { name: 'PeerAnswerCollectionCron.collectOpenAnswers', exclusive: true })
  async collectOpenAnswers(): Promise<void> {
    if (!(await this.featureService.isFeatureEnabled('ask'))) {
      return;
    }

    const { checked, answered } = await this.outboundAskService.collectOpenAnswers();
    if (checked > 0) {
      this.logger.log(`collected ${answered} of ${checked} open outbound asks`);
    }
  }
}
