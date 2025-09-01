/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';

import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema for the tool
const browserOperatorInputSchema = z.object({
  action: z.enum(['navigate', 'screenshot', 'getText', 'click', 'type', 'waitFor']),
  url: z.string().url().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  waitTime: z.number().min(100).max(30000).optional(), // milliseconds
  fullPage: z.boolean().optional(), // for screenshots
});

type BrowserOperatorInput = z.infer<typeof browserOperatorInputSchema>;

// Output interface
interface BrowserOperatorOutput {
  success: boolean;
  data?: any;
  screenshot?: string; // base64 encoded image
  text?: string;
  url?: string;
  error?: string;
}

/**
 * Headless browser automation tool using Playwright
 * Provides basic browser operations for web automation tasks
 */
@Injectable()
export class BrowserOperatorTool extends BaseTool<BrowserOperatorInput, BrowserOperatorOutput> {
  readonly schema = {
    name: 'browser_operator',
    description:
      'Operate a headless browser to navigate websites, take screenshots, extract text, click elements, and fill forms. Useful for web scraping, testing, and automation.',
    category: 'automation',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'getText', 'click', 'type', 'waitFor'],
          description: 'The browser action to perform',
        },
        url: {
          type: 'string',
          format: 'uri',
          description: 'URL to navigate to (required for navigate action)',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for element operations (required for click, type, getText on specific elements)',
        },
        text: {
          type: 'string',
          description: 'Text to type (required for type action)',
        },
        waitTime: {
          type: 'number',
          minimum: 100,
          maximum: 30000,
          description: 'Time to wait in milliseconds (for waitFor action)',
        },
        fullPage: {
          type: 'boolean',
          description: 'Whether to take a full page screenshot (default: false)',
        },
      },
      required: ['action'],
    },
    examples: [
      {
        input: { action: 'navigate', url: 'https://example.com' },
        output: { success: true, url: 'https://example.com' },
        description: 'Navigate to a website',
      },
      {
        input: { action: 'screenshot', fullPage: true },
        output: { success: true, screenshot: 'base64-encoded-image-data' },
        description: 'Take a full page screenshot',
      },
      {
        input: { action: 'getText', selector: 'h1' },
        output: { success: true, text: 'Welcome to Example.com' },
        description: 'Extract text from an element',
      },
      {
        input: { action: 'click', selector: 'button#submit' },
        output: { success: true },
        description: 'Click a button',
      },
      {
        input: { action: 'type', selector: 'input[name="email"]', text: 'user@example.com' },
        output: { success: true },
        description: 'Type text into an input field',
      },
    ],
  };

  private browser: Browser | null = null;
  private page: Page | null = null;

  protected validateInput(input: unknown): BrowserOperatorInput {
    return browserOperatorInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: BrowserOperatorInput,
  ): Promise<BrowserOperatorOutput> {
    try {
      await this.ensureBrowser();

      switch (input.action) {
        case 'navigate':
          return await this.navigate(input.url!);
        case 'screenshot':
          return await this.screenshot(input.fullPage);
        case 'getText':
          return await this.getText(input.selector);
        case 'click':
          return await this.click(input.selector!);
        case 'type':
          return await this.type(input.selector!, input.text!);
        case 'waitFor':
          return await this.waitFor(input.waitTime || 1000);
        default:
          throw new Error(`Unknown action: ${input.action}`);
      }
    } catch (error) {
      this.logger.error('Browser operation failed', {
        toolName: this.schema.name,
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (!this.browser) {
      this.logger.debug('Launching browser');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    if (!this.page) {
      this.logger.debug('Creating new page');
      this.page = await this.browser.newPage();
      
      // Set a reasonable viewport size
      await this.page.setViewportSize({ width: 1280, height: 720 });
      
      // Set a user agent to avoid blocking
      await this.page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      );
    }
  }

  private async navigate(url: string): Promise<BrowserOperatorOutput> {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }

    this.logger.debug('Navigating to URL', { url });
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    return {
      success: true,
      url: this.page.url(),
    };
  }

  private async screenshot(fullPage?: boolean): Promise<BrowserOperatorOutput> {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }

    this.logger.debug('Taking screenshot', { fullPage });
    const screenshot = await this.page.screenshot({
      fullPage: fullPage || false,
      type: 'png',
    });

    return {
      success: true,
      screenshot: screenshot.toString('base64'),
    };
  }

  private async getText(selector?: string): Promise<BrowserOperatorOutput> {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }

    if (selector) {
      this.logger.debug('Getting text from element', { selector });
      const element = await this.page.locator(selector);
      const text = await element.textContent();
      
      return {
        success: true,
        text: text || '',
      };
    } else {
      this.logger.debug('Getting page text content');
      const text = await this.page.textContent('body');
      
      return {
        success: true,
        text: text || '',
      };
    }
  }

  private async click(selector: string): Promise<BrowserOperatorOutput> {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }

    this.logger.debug('Clicking element', { selector });
    await this.page.locator(selector).click({ timeout: 10000 });
    
    return {
      success: true,
    };
  }

  private async type(selector: string, text: string): Promise<BrowserOperatorOutput> {
    if (!this.page) {
      throw new Error('Browser page not initialized');
    }

    this.logger.debug('Typing text into element', { selector, textLength: text.length });
    const element = this.page.locator(selector);
    await element.fill(text, { timeout: 10000 });
    
    return {
      success: true,
    };
  }

  private async waitFor(waitTime: number): Promise<BrowserOperatorOutput> {
    this.logger.debug('Waiting', { waitTime });
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    return {
      success: true,
    };
  }

  /**
   * Clean up browser resources
   */
  async cleanup(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  protected sanitizeInputForLogging(input: unknown): any {
    if (typeof input === 'object' && input !== null) {
      const sanitized = { ...input } as any;
      // Don't log potentially sensitive text content
      if (sanitized.text && sanitized.text.length > 100) {
        sanitized.text = `${sanitized.text.substring(0, 100)}... (${sanitized.text.length} chars)`;
      }
      return sanitized;
    }
    return input;
  }
}