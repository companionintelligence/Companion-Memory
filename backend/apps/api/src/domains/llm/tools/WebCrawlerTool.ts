/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { z } from 'zod';

import config from '@ci/configuration';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema for the tool
const webCrawlerInputSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  maxPages: z.number().min(1).max(10).optional().default(1),
  deepCrawl: z.boolean().optional().default(false),
  extractQuery: z
    .string()
    .optional()
    .describe('Optional LLM extraction query to extract specific information'),
  crawlStrategy: z.enum(['bfs', 'dfs']).optional().default('bfs'),
  extractLinks: z.boolean().optional().default(true),
  extractMedia: z.boolean().optional().default(false),
  wordCountThreshold: z.number().min(1).optional().default(10),
});

type WebCrawlerInput = z.infer<typeof webCrawlerInputSchema>;

// Output interface
interface CrawlResult {
  success: boolean;
  url: string;
  markdown?: string;
  html?: string;
  links?: string[];
  media?: Array<{
    type: string;
    url: string;
    alt?: string;
  }>;
  metadata?: {
    title?: string;
    description?: string;
    wordCount?: number;
    crawlTimestamp?: string;
  };
  pagesCrawled: number;
  error?: string;
}

interface WebCrawlerOutput {
  results: CrawlResult[];
  totalPagesCrawled: number;
  successCount: number;
  errorCount: number;
  summary: string;
}

/**
 * Tool to crawl websites and extract content using the crawler service
 * Useful for gathering information from web pages, extracting specific data,
 * and performing research tasks that require web content analysis
 */
@Injectable()
export class WebCrawlerTool extends BaseTool<WebCrawlerInput, WebCrawlerOutput> {
  readonly schema = {
    name: 'webCrawler',
    description:
      'Crawl websites and extract markdown content, links, and media. Can perform single-page crawls or deep crawls across multiple pages. Use this tool when you need to gather information from websites, extract specific data, or perform research tasks.',
    category: 'external_api',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'The URL to crawl (required)',
        },
        maxPages: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'Maximum number of pages to crawl (1-10, default: 1)',
        },
        deepCrawl: {
          type: 'boolean',
          description: 'Enable deep crawling across multiple pages (default: false)',
        },
        extractQuery: {
          type: 'string',
          description: 'Optional LLM extraction query to extract specific information from the page',
        },
        crawlStrategy: {
          type: 'string',
          enum: ['bfs', 'dfs'],
          description:
            'Crawl strategy for deep crawls - breadth-first (bfs) or depth-first (dfs) (default: bfs)',
        },
        extractLinks: {
          type: 'boolean',
          description: 'Extract links from crawled pages (default: true)',
        },
        extractMedia: {
          type: 'boolean',
          description: 'Extract media files (images, videos) from crawled pages (default: false)',
        },
        wordCountThreshold: {
          type: 'number',
          minimum: 1,
          description: 'Minimum word count for content to be included (default: 10)',
        },
      },
      required: ['url'],
    },
    examples: [
      {
        input: {
          url: 'https://news.ycombinator.com',
          maxPages: 1,
          extractLinks: true,
        },
        output: {
          results: [
            {
              success: true,
              url: 'https://news.ycombinator.com',
              markdown: '# Hacker News\n\nTop stories...',
              links: ['https://news.ycombinator.com/item?id=123', 'https://example.com'],
              metadata: {
                title: 'Hacker News',
                wordCount: 150,
              },
              pagesCrawled: 1,
            },
          ],
          totalPagesCrawled: 1,
          successCount: 1,
          errorCount: 0,
          summary: 'Successfully crawled 1 page from Hacker News',
        },
        description: 'Simple crawl of a news website to get current content',
      },
      {
        input: {
          url: 'https://docs.python.org',
          maxPages: 3,
          deepCrawl: true,
          crawlStrategy: 'bfs',
          extractQuery: 'Extract all function names and their descriptions',
        },
        output: {
          results: [
            {
              success: true,
              url: 'https://docs.python.org',
              markdown: '# Python Documentation\n\n## Functions\n\n- print(): Output text...',
              links: ['https://docs.python.org/library/', 'https://docs.python.org/tutorial/'],
              metadata: {
                title: 'Python Documentation',
                wordCount: 500,
              },
              pagesCrawled: 3,
            },
          ],
          totalPagesCrawled: 3,
          successCount: 1,
          errorCount: 0,
          summary: 'Successfully crawled 3 pages from Python documentation with function extraction',
        },
        description: 'Deep crawl with LLM extraction to find specific information',
      },
    ],
  };

  constructor() {
    super();
  }

  protected validateInput(input: unknown): WebCrawlerInput {
    return webCrawlerInputSchema.parse(input);
  }

  protected async executeInternal(
    _context: ToolExecutionContext,
    input: WebCrawlerInput,
  ): Promise<WebCrawlerOutput> {
    const crawlerHost = config.services.crawler?.host || 'http://localhost:9003';

    try {
      // Prepare the request payload
      const crawlRequest = {
        url: input.url,
        max_pages: input.maxPages,
        deep_crawl: input.deepCrawl,
        crawl_strategy: input.crawlStrategy,
        extract_links: input.extractLinks,
        extract_media: input.extractMedia,
        word_count_threshold: input.wordCountThreshold,
        ...(input.extractQuery && {
          extraction_strategy: 'llm',
          extraction_query: input.extractQuery,
        }),
      };

      this.logger.debug('Calling crawler service', {
        url: input.url,
        maxPages: input.maxPages,
        deepCrawl: input.deepCrawl,
        crawlerHost,
      });

      // Call the crawler service
      const response = await axios.post(`${crawlerHost}/crawl`, crawlRequest, {
        timeout: 60000, // 60 second timeout for crawls
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.status !== 200) {
        throw new Error(`Crawler service returned status ${response.status}`);
      }

      const crawlResult: CrawlResult = response.data;

      // Generate summary
      const summary = this.generateSummary(crawlResult, input);

      return {
        results: [crawlResult],
        totalPagesCrawled: crawlResult.pagesCrawled,
        successCount: crawlResult.success ? 1 : 0,
        errorCount: crawlResult.success ? 0 : 1,
        summary,
      };
    } catch (error) {
      this.logger.error('Crawler service error', {
        url: input.url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      const errorResult: CrawlResult = {
        success: false,
        url: input.url,
        pagesCrawled: 0,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };

      return {
        results: [errorResult],
        totalPagesCrawled: 0,
        successCount: 0,
        errorCount: 1,
        summary: `Failed to crawl ${input.url}: ${errorResult.error}`,
      };
    }
  }

  private generateSummary(result: CrawlResult, input: WebCrawlerInput): string {
    if (!result.success) {
      return `Failed to crawl ${input.url}: ${result.error}`;
    }

    const pagesText = result.pagesCrawled === 1 ? 'page' : 'pages';
    const linksText = result.links ? `, found ${result.links.length} links` : '';
    const mediaText = result.media ? `, found ${result.media.length} media files` : '';
    const wordCountText = result.metadata?.wordCount ? ` (${result.metadata.wordCount} words)` : '';

    let summary = `Successfully crawled ${result.pagesCrawled} ${pagesText} from ${input.url}${wordCountText}${linksText}${mediaText}`;

    if (input.extractQuery) {
      summary += ` with LLM extraction: "${input.extractQuery}"`;
    }

    if (input.deepCrawl) {
      summary += ` using ${input.crawlStrategy} strategy`;
    }

    return summary;
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // Remove potentially sensitive URL data for logging
    const sanitized = input as any;
    if (sanitized?.url) {
      try {
        const url = new URL(sanitized.url);
        sanitized.url = `${url.protocol}//${url.hostname}${url.pathname}`;
      } catch {
        // If URL parsing fails, just truncate
        sanitized.url = sanitized.url.substring(0, 50) + '...';
      }
    }

    return sanitized;
  }
}
