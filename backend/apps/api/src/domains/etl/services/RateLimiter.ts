import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { RateLimitConfig, RateLimiterState } from '../types/api-spec';

/**
 * RateLimiter implements token bucket algorithm for API rate limiting.
 */
@Injectable()
export class RateLimiter {
  private limiters = new Map<string, RateLimiterState>();

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(RateLimiter.name);
  }

  /**
   * Wait for rate limit before making request
   * @param key - Unique key for this rate limiter (e.g., "provider:endpoint")
   * @param config - Rate limit configuration
   */
  async wait(key: string, config?: RateLimitConfig): Promise<void> {
    if (!config) {
      return;
    }

    let state = this.limiters.get(key);
    if (!state) {
      state = this.initializeState(config);
      this.limiters.set(key, state);
    }

    // Refill tokens based on time elapsed
    this.refillTokens(state, config);

    // Check if we have tokens available
    if (state.tokensRemaining <= 0) {
      const delay = this.calculateDelay(state, config);
      if (delay > 0) {
        this.logger.debug(`Rate limit: waiting ${delay}ms for key ${key}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        
        // Refill after waiting
        this.refillTokens(state, config);
      }
    }

    // Consume a token
    if (state.tokensRemaining > 0) {
      state.tokensRemaining--;
      state.requestsInWindow++;
    }
  }

  /**
   * Check if request is allowed without consuming token
   */
  async checkLimit(key: string, config?: RateLimitConfig): Promise<boolean> {
    if (!config) {
      return true;
    }

    let state = this.limiters.get(key);
    if (!state) {
      return true; // No state yet, allow request
    }

    this.refillTokens(state, config);
    return state.tokensRemaining > 0;
  }

  /**
   * Get current rate limiter state
   */
  getState(key: string): RateLimiterState | null {
    return this.limiters.get(key) ?? null;
  }

  /**
   * Reset rate limiter for a key
   */
  reset(key: string): void {
    this.limiters.delete(key);
    this.logger.debug(`Rate limiter reset for: ${key}`);
  }

  /**
   * Initialize rate limiter state
   */
  private initializeState(config: RateLimitConfig): RateLimiterState {
    const now = new Date();
    const capacity = this.calculateCapacity(config);

    return {
      tokensRemaining: capacity,
      refillAt: new Date(now.getTime() + this.getRefillInterval(config)),
      requestsInWindow: 0,
      windowResetAt: new Date(now.getTime() + this.getWindowDuration(config)),
    };
  }

  /**
   * Calculate token bucket capacity based on config
   */
  private calculateCapacity(config: RateLimitConfig): number {
    if (config.requestsPerSecond) {
      return config.requestsPerSecond;
    }
    if (config.requestsPerMinute) {
      return Math.ceil(config.requestsPerMinute / 60);
    }
    if (config.requestsPerHour) {
      return Math.ceil(config.requestsPerHour / 3600);
    }
    if (config.requestsPerDay) {
      return Math.ceil(config.requestsPerDay / 86400);
    }
    return 10; // Default capacity
  }

  /**
   * Get refill interval in milliseconds
   */
  private getRefillInterval(config: RateLimitConfig): number {
    if (config.requestsPerSecond) {
      return 1000; // 1 second
    }
    if (config.requestsPerMinute) {
      return 60000; // 1 minute
    }
    if (config.requestsPerHour) {
      return 3600000; // 1 hour
    }
    if (config.requestsPerDay) {
      return 86400000; // 1 day
    }
    return 1000; // Default 1 second
  }

  /**
   * Get window duration in milliseconds
   */
  private getWindowDuration(config: RateLimitConfig): number {
    return this.getRefillInterval(config);
  }

  /**
   * Calculate delay needed before next request
   */
  private calculateDelay(state: RateLimiterState, config: RateLimitConfig): number {
    const now = new Date();
    const refillTime = state.refillAt.getTime();
    const nowTime = now.getTime();

    if (refillTime > nowTime) {
      return refillTime - nowTime;
    }

    return 0;
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refillTokens(state: RateLimiterState, config: RateLimitConfig): void {
    const now = new Date();
    const capacity = this.calculateCapacity(config);

    // Check if it's time to refill
    if (now >= state.refillAt) {
      state.tokensRemaining = capacity;
      state.refillAt = new Date(now.getTime() + this.getRefillInterval(config));
    }

    // Check if window has reset
    if (now >= state.windowResetAt) {
      state.requestsInWindow = 0;
      state.windowResetAt = new Date(now.getTime() + this.getWindowDuration(config));
    }
  }
}
