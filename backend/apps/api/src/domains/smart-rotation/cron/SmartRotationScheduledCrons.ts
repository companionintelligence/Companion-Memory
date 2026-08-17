import { Injectable } from '@nestjs/common';

import { Cron } from '@ci/common/schedule';

import { SmartRotationService } from '../services/SmartRotationService';
import { SMART_ROTATION_CRONS } from '../types';

/** Question feed top-up — same 20m cadence as the legacy FeedQueueCron. */
@Injectable()
export class SmartRotationQuestionFeedCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.question_feed)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('question_feed');
  }
}

/** Answer inference — throttled to 20m under smart.rotation (legacy ran every minute). */
@Injectable()
export class SmartRotationAnswerInferCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.answer_infer)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('answer_infer');
  }
}

/** Schedule slate sync — every 30 minutes at :14. */
@Injectable()
export class SmartRotationScheduleSyncCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.schedule_sync)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('schedule_sync');
  }
}

/** Proactive insights — every 3 hours (matches summary-service system schedule). */
@Injectable()
export class SmartRotationInsightsCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.insights)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('insights');
  }
}

/** Activity summaries / dossier refresh — hourly. */
@Injectable()
export class SmartRotationSummariesCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.summaries)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('summaries');
  }
}

/** Deterministic graph linking — extract people, link comms/events (Import Tools stages 4–6). */
@Injectable()
export class SmartRotationGraphLinkCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.graph_link)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('graph_link');
  }
}

/** Graph relationship enrichment — every 6 hours when new memory exists. */
@Injectable()
export class SmartRotationGraphEnrichCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.graph_enrich)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('graph_enrich');
  }
}

/** Fill the feed context-prompt slot — every 4 hours. */
@Injectable()
export class SmartRotationContextPromptCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.context_prompt)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('context_prompt');
  }
}

/** Hydrate graph from recent answers — daily. */
@Injectable()
export class SmartRotationHydrateAnswersCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.hydrate_answers)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('hydrate_answers');
  }
}

/** Hydrate graph from inventory — daily. */
@Injectable()
export class SmartRotationHydrateInventoryCron {
  constructor(private readonly rotationService: SmartRotationService) {}

  @Cron(SMART_ROTATION_CRONS.hydrate_inventory)
  async run(): Promise<void> {
    await this.rotationService.runScheduledWork('hydrate_inventory');
  }
}
