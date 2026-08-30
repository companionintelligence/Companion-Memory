import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { SYSTEM_USER, type RequestContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { BrowserActivityService, BROWSER_ACTIVITY_CATEGORIES } from '@ci/domains/browser-activity';
import {
  BrowserActivityCreatedEvent,
  type BrowserActivityCreatedPayload,
} from '@ci/domains/browser-activity/events';
import { OnEvent } from '@ci/domains/events';

import { BROWSER_ACTIVITY_INSIGHTS_QUEUE, BROWSER_ACTIVITY_INSIGHTS_QUEUE_OPTIONS } from '../constants';
import { OllamaService, UTILITY_MODEL } from '../services/OllamaService';

/**
 * Grammar-level guard passed to Ollama's `format`, constraining generation to
 * this shape. As with `ConceptExtractionService`'s `EXTRACTION_JSON_SCHEMA`,
 * this only binds SHAPE — a schema-constrained small model still happily
 * emits a `productivity_score` like `-1` or `1.4` for a field it was merely
 * told about in prose — so {@link InsightSchema} stays the real gate below.
 */
const INSIGHT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...BROWSER_ACTIVITY_CATEGORIES] },
    productivity_score: { type: 'number' },
  },
  required: ['category', 'productivity_score'],
};

const InsightSchema = z.object({
  category: z.enum(BROWSER_ACTIVITY_CATEGORIES),
  productivity_score: z.number().min(0).max(1),
});

type Insight = z.infer<typeof InsightSchema>;

/**
 * Builds the one prompt this listener ever sends. Deliberately spare: the
 * browser extension's live ingest ships no page content — see
 * `createBrowserActivitySchemaRoot`, whose fields are url, title, action_type,
 * duration, scroll depth and a free-form `properties` bag, nothing else — so
 * url + title + action_type is the entire evidence base. Asking the model for
 * more than a category and a score from that little would just invite a
 * confident-sounding fabrication.
 */
function buildPrompt(input: { url: string; title: string | null; actionType: string | null }): string {
  return `
You are labelling ONE web page visit for a personal analytics feature. You
only know the URL, the page title, and the browser action that produced this
row — you have NOT seen the page's content, so infer conservatively from what
a URL and title usually imply about a site's purpose.

You are a JSON generator. Output ONLY valid JSON. Do not include markdown
fences or any commentary.

Pick exactly one category from this fixed list:
${BROWSER_ACTIVITY_CATEGORIES.join(', ')}
- work: job tools, docs, code, project/task trackers, work email or chat
- entertainment: video, music, games, streaming, memes
- social: social-media feeds, forums, community sites
- shopping: retail, marketplaces, product pages, checkout flows
- news: news outlets, current-events sites
- reference: search engines, documentation, wikis, how-to or learning content
- communication: personal email/chat/video-call tools not tied to work
- other: anything that clearly does not fit above, or is too ambiguous to guess

Also estimate productivity_score, a float from 0.0 to 1.0: 1.0 for clearly
goal-directed/work activity, 0.0 for pure leisure or distraction, 0.5 for a
genuinely ambiguous or mixed-use site. Judge it from the category and what the
URL/title suggest, not from the action type alone.

Page visited:
URL: ${input.url}
Title: ${input.title ?? '(no title)'}
Action: ${input.actionType ?? 'visit'}

Return a JSON object with exactly this shape:
{"category": "reference", "productivity_score": 0.7}
`.trim();
}

/**
 * The AI producer for `browser_activity.category` and `.productivity_score` —
 * two columns whose entity has carried an "AI-generated insights" comment
 * since it was written, but which a prior audit found NOTHING in the codebase
 * ever actually computed: every reference was a type definition or a
 * straight DTO field-copy. This listener is that producer.
 *
 * ── Why url + title, and not page content ───────────────────────────────────
 *
 * The extension's live ingest (`POST /browser-activity` →
 * `BrowserActivityService.create`) is the ONLY path that fires
 * `BrowserActivityCreatedEvent` per row — the bulk browser-history importer's
 * `createManyDetailed` deliberately does not, to avoid a per-row pg-boss
 * fan-out at import volume (see that method's own comment) — and it never
 * sends page content. So this classification is url/title/action_type only,
 * the same ceiling the extension itself has.
 *
 * ── Why NOT `page_summary` ───────────────────────────────────────────────────
 *
 * A "summary" generated from nothing but a URL and a title would mostly
 * restate the title in a longer sentence, or invent specifics about content
 * the model never saw — materially worse than leaving the column null.
 * `page_summary` already has one honest producer (the bulk importer, which
 * copies Firefox's own parsed page description — real metadata, not a guess)
 * and this listener deliberately leaves that column alone for
 * extension-sourced rows too. Wiring up a real producer for it — e.g. a
 * content script capturing the page's own meta description, or a Readability
 * extract — is a reasonable follow-up, but reusing a URL/title into a fake
 * "summary" is not that: it is this decision to revisit if a maintainer wants
 * it.
 *
 * ── Why not `OllamaService.resolveModel` ─────────────────────────────────────
 *
 * `ImageDescriptionListener`/`ThingVisionListener` call `resolveModel`
 * because they need a model that can actually SEE the image they send. This
 * call is pure text, so it follows the background-classification convention
 * used elsewhere in this codebase (`ConceptExtractionService`,
 * `TaskBreakdownService`): call `UTILITY_MODEL` directly. `UTILITY_MODEL` is
 * the model background/queued work should use — see its own doc comment for
 * why sharing the interactive chat model with cron/queue work silently
 * breaks background jobs the moment an operator raises the chat model for
 * quality.
 *
 * ── Volume guard ─────────────────────────────────────────────────────────────
 *
 * Browser activity is far higher-volume than image uploads, so this listener:
 *   - skips incognito (`is_incognito`) rows outright, per the task brief, AND
 *     skips `contains_sensitive` rows too — a stricter reading of the same
 *     privacy intent those two columns already exist to express, at no extra
 *     cost;
 *   - skips rows that already carry a `category` — idempotent against a
 *     redelivered event, and non-destructive toward any future producer that
 *     already filled the column in;
 *   - shares `BROWSER_ACTIVITY_INSIGHTS_QUEUE`'s `localConcurrency: 1`, the
 *     same one-slot discipline `LLM_QUEUE`/`IMAGE_DESCRIPTION_QUEUE`/
 *     `THING_VISION_QUEUE` already use to keep a local 1-2 slot GPU from being
 *     stampeded, so a burst of page visits queues up and drains serially
 *     instead of firing concurrent generations.
 *
 * A dedicated per-user rate limiter was considered and deliberately dropped:
 * nothing in `domains/llm` throttles per-user today (the closest precedent,
 * `domains/asks/rateLimit.ts`, is purpose-built for the ask-abuse path), and
 * the GPU-serialized queue already bounds concurrency to one in-flight call
 * appliance-wide. A maintainer who finds the backlog too deep on a busy
 * appliance has a clear next lever: sample (e.g. classify 1 in N visits per
 * host) rather than classify every row.
 */
@Injectable()
export class BrowserActivityInsightsListener {
  constructor(
    private readonly browserActivityService: BrowserActivityService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BrowserActivityInsightsListener.name);
  }

  @OnEvent(BrowserActivityCreatedEvent, {
    queue: BROWSER_ACTIVITY_INSIGHTS_QUEUE,
    queueOptions: BROWSER_ACTIVITY_INSIGHTS_QUEUE_OPTIONS,
  })
  async handle(payload: BrowserActivityCreatedPayload) {
    // Unlike PreviewGeneratedPayload/FileUploadedPayload, this payload carries
    // no userId — read the row first, the same way BrowserActivitySearchIndexListener
    // (an existing consumer of this same event, on the unrelated
    // 'search-index' queue) already does.
    const systemContext: ServiceContext = { userId: SYSTEM_USER };

    const activity = await this.browserActivityService.findById(systemContext, payload.browserActivityId);

    if (activity == null) {
      this.logger.warn('Browser activity not found, skipping insight generation', {
        browserActivityId: payload.browserActivityId,
      });

      return;
    }

    if (activity.is_incognito || activity.contains_sensitive) {
      this.logger.log('Browser activity flagged private, skipping insight generation', {
        browserActivityId: activity.id,
        isIncognito: activity.is_incognito,
        containsSensitive: activity.contains_sensitive,
      });

      return;
    }

    if (!activity.url || activity.url.trim().length === 0) {
      this.logger.warn('Browser activity has no URL, skipping insight generation', {
        browserActivityId: activity.id,
      });

      return;
    }

    if (activity.category != null) {
      this.logger.log('Browser activity already categorized, skipping insight generation', {
        browserActivityId: activity.id,
      });

      return;
    }

    const llmContext: RequestContext = { userId: activity.user_id };
    const messages = [
      {
        role: 'user' as const,
        content: buildPrompt({
          url: activity.url,
          title: activity.title ?? null,
          actionType: activity.action_type ?? null,
        }),
      },
    ];

    this.logger.log('Starting LLM chat for browser activity insight', {
      model: UTILITY_MODEL,
      browserActivityId: activity.id,
    });

    let response;
    try {
      response = await this.ollamaService.chat(llmContext, messages, {
        model: UTILITY_MODEL,
        enableTools: false,
        format: INSIGHT_JSON_SCHEMA,
      });
    } catch (error) {
      this.logger.warn(
        'Browser activity insight generation failed; leaving category/productivity_score unset',
        {
          browserActivityId: activity.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );

      return;
    }

    const content = response.message.content.trim();

    if (!content) {
      this.logger.warn('LLM returned empty response', { browserActivityId: activity.id });

      return;
    }

    const insight = this.parseResponse(content);

    if (insight == null) {
      this.logger.warn('Failed to parse browser activity insight from LLM response', {
        browserActivityId: activity.id,
        content,
      });

      return;
    }

    await this.browserActivityService.update(systemContext, activity.id, {
      category: insight.category,
      productivity_score: insight.productivity_score,
    });

    this.logger.log('Browser activity insight applied', {
      browserActivityId: activity.id,
      category: insight.category,
      productivityScore: insight.productivity_score,
    });
  }

  private parseResponse(content: string): Insight | null {
    let jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();

    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    try {
      const result = InsightSchema.safeParse(JSON.parse(jsonStr));

      if (!result.success) {
        this.logger.error(result.error, 'LLM response failed schema validation');

        return null;
      }

      return result.data;
    } catch (error) {
      this.logger.error(error as Error, 'Failed to parse JSON from LLM response');

      return null;
    }
  }
}
