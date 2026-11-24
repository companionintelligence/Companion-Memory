import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import {
  BrowserActivityCreatedEvent,
  type BrowserActivityCreatedPayload,
} from '@ci/domains/browser-activity/events';
import { OnEvent } from '@ci/domains/events';

import { BROWSER_ACTIVITY_INSIGHT_QUEUE, BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS } from '../constants';
import { BrowserActivityInsightPreferenceService } from '../services/BrowserActivityInsightPreferenceService';
import { OllamaService } from '../services/OllamaService';

/**
 * A fixed, closed set rather than an LLM-chosen free-text string. `category`
 * exists to be filtered and charted; an unbounded vocabulary would defeat
 * that the moment two visits to the same kind of page got labelled
 * differently ("news" vs "current events").
 */
export const BROWSER_ACTIVITY_CATEGORIES = [
  'work',
  'development',
  'communication',
  'reference',
  'news',
  'shopping',
  'social',
  'entertainment',
  'other',
] as const;

export type BrowserActivityCategory = (typeof BROWSER_ACTIVITY_CATEGORIES)[number];

/**
 * `productivity_score` is derived from the category rather than asked of the
 * model as a second float. A per-page score guessed from a URL and a title
 * alone is noisy and hard to justify ("why is this 0.6 and not 0.7?"); a
 * lookup keyed on the category the model already committed to is stable,
 * explainable, and free — no second judgement call to get wrong.
 */
const PRODUCTIVITY_SCORE_BY_CATEGORY: Record<BrowserActivityCategory, number> = {
  development: 0.9,
  work: 0.8,
  reference: 0.7,
  other: 0.5,
  news: 0.4,
  shopping: 0.3,
  communication: 0.3,
  social: 0.2,
  entertainment: 0.1,
};

/**
 * A revisit to the same URL within this window reuses the prior category
 * instead of paying another LLM call — revisiting a page is the common case,
 * not the exception, and the classification does not change page to page.
 */
const RECENT_CATEGORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const InsightSchema = z.object({
  category: z.enum(BROWSER_ACTIVITY_CATEGORIES),
});

/** Grammar-constrained via `format` so the model cannot emit a category outside the enum. */
const INSIGHT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...BROWSER_ACTIVITY_CATEGORIES] },
  },
  required: ['category'],
};

const PROMPT_PREAMBLE = [
  'You classify a single browser page visit into exactly one category from a fixed list, using only its URL and title.',
  'You are a JSON generator. Output ONLY valid JSON. Do not include conversational text, markdown, or explanations.',
  '',
  'Categories:',
  '- work: task trackers, documents, spreadsheets, internal tools, professional research',
  '- development: code hosting, technical docs, package registries, in-browser IDEs',
  '- communication: email, chat, video calls',
  '- reference: encyclopedias, documentation, how-to guides, dictionaries',
  '- news: news sites and current-events aggregators',
  '- shopping: retail sites, marketplaces, product listings',
  '- social: social networks, forums, community feeds',
  '- entertainment: video, music, streaming, games, casual browsing',
  '- other: anything that does not clearly fit the above',
  '',
  'Return JSON: {"category": "<one of the categories above>"}',
].join('\n');

/**
 * Fills in the two "AI-generated insights" columns `BrowserActivityEntity`
 * has carried with no producer: `category` and `productivity_score`.
 * `page_summary` is deliberately left out of scope — the extension sends only
 * url/title/action_type/properties, never page content, and a "summary" built
 * from a URL and a title alone is a paraphrase wearing a stronger name than it
 * has earned.
 *
 * Off by default (`BrowserActivityInsightPreferenceService`), same reasoning
 * as `ImageDescriptionListener`: this runs on every page visit, a much
 * higher-volume trigger than an image upload.
 */
@Injectable()
export class BrowserActivityInsightListener {
  constructor(
    private readonly browserActivityService: BrowserActivityService,
    private readonly ollamaService: OllamaService,
    private readonly preference: BrowserActivityInsightPreferenceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BrowserActivityInsightListener.name);
  }

  @OnEvent(BrowserActivityCreatedEvent, {
    queue: BROWSER_ACTIVITY_INSIGHT_QUEUE,
    queueOptions: BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS,
  })
  async handle(payload: BrowserActivityCreatedPayload) {
    // The event carries only the id (unlike PreviewGeneratedPayload) — the
    // row has to be loaded before anything else, including whose preference
    // to check, is known.
    const systemContext = { userId: SYSTEM_USER } satisfies ServiceContext;
    const browserActivity = await this.browserActivityService.findById(
      systemContext,
      payload.browserActivityId,
    );

    if (browserActivity == null) {
      this.logger.warn('Browser activity not found, skipping insight generation', {
        browserActivityId: payload.browserActivityId,
      });

      return;
    }

    if (browserActivity.is_incognito || browserActivity.contains_sensitive) {
      this.logger.log('Browser activity is incognito or sensitive, skipping insight generation', {
        browserActivityId: browserActivity.id,
      });

      return;
    }

    if (!(await this.preference.isEnabled(browserActivity.user_id))) {
      this.logger.log('Browser activity insights disabled — skipping', {
        browserActivityId: browserActivity.id,
        userId: browserActivity.user_id,
      });

      return;
    }

    const since = new Date(browserActivity.time.getTime() - RECENT_CATEGORY_WINDOW_MS);
    const recent = await this.browserActivityService.findMostRecentCategorized(
      browserActivity.user_id,
      browserActivity.url,
      since,
    );

    if (recent != null) {
      this.logger.log('Reusing a recent category for this URL, skipping LLM call', {
        browserActivityId: browserActivity.id,
        category: recent.category,
      });

      await this.browserActivityService.update(systemContext, browserActivity.id, {
        category: recent.category ?? undefined,
        productivity_score: recent.productivity_score ?? undefined,
      });

      return;
    }

    const category = await this.classify(
      browserActivity.user_id,
      browserActivity.url,
      browserActivity.title ?? null,
    );

    if (category == null) {
      return;
    }

    await this.browserActivityService.update(systemContext, browserActivity.id, {
      category,
      productivity_score: PRODUCTIVITY_SCORE_BY_CATEGORY[category],
    });

    this.logger.log('Browser activity categorized', {
      browserActivityId: browserActivity.id,
      category,
    });
  }

  private async classify(
    userId: string,
    url: string,
    title: string | null,
  ): Promise<BrowserActivityCategory | null> {
    const prompt = [
      PROMPT_PREAMBLE,
      '',
      `Title: ${title || '(no title)'}`,
      `URL: ${this.sanitizeUrl(url)}`,
    ].join('\n');

    try {
      const response = await this.ollamaService.chat({ userId }, [{ role: 'user', content: prompt }], {
        tier: 'utility',
        enableTools: false,
        format: INSIGHT_JSON_SCHEMA,
      });

      const parsed = InsightSchema.parse(JSON.parse(response.message.content));

      return parsed.category;
    } catch (error) {
      this.logger.warn('Browser activity classification failed; leaving category unset', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });

      return null;
    }
  }

  /**
   * Origin + path only. Query strings and fragments routinely carry session
   * tokens, search terms, or other identifying data that has no business
   * leaving the appliance for a classification that only needs to know what
   * KIND of page this is, not the specifics of the visit.
   */
  private sanitizeUrl(url: string): string {
    try {
      const parsed = new URL(url);

      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      // Not a parseable absolute URL (a bare search query, a synthetic
      // `search:<query>` identity — see createBrowserActivitySchemaRoot).
      // Still strip anything after `?`/`#` on a best-effort basis.
      return url.split(/[?#]/)[0] ?? url;
    }
  }
}
