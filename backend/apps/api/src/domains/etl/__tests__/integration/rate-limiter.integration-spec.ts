/**
 * Rate Limiter Integration Tests
 * 
 * Tests rate limiting logic, token bucket algorithm, and request throttling
 */

import { Test, TestingModule } from '@nestjs/testing';

import { LoggerService } from '@ci/common/logging';
import { createMockLogger } from '@ci/test/mocks';

import { RateLimiter } from '../../services/RateLimiter';
import type { RateLimitConfig } from '../../types/api-spec';

describe('RateLimiter Integration Tests', () => {
  let rateLimiter: RateLimiter;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        RateLimiter,
        {
          provide: LoggerService,
          useValue: createMockLogger(),
        },
      ],
    }).compile();

    rateLimiter = module.get<RateLimiter>(RateLimiter);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('Token Bucket Algorithm', () => {
    it('should allow requests within rate limit', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 20,
      };

      const providerId = 'test-provider';
      
      // Should allow 10 requests
      for (let i = 0; i < 10; i++) {
        const allowed = await rateLimiter.checkLimit(providerId, config);
        expect(allowed).toBe(true);
        await rateLimiter.recordRequest(providerId, config);
      }
    });

    it('should block requests exceeding rate limit', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 2,
      };

      const providerId = 'test-provider';
      
      // First 2 requests should succeed (burst)
      await rateLimiter.checkLimit(providerId, config);
      await rateLimiter.recordRequest(providerId, config);
      await rateLimiter.checkLimit(providerId, config);
      await rateLimiter.recordRequest(providerId, config);
      
      // Third request should be blocked
      const allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(false);
    });

    it('should refill tokens over time', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const providerId = 'test-provider';
      
      // Exhaust all tokens
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit(providerId, config);
        await rateLimiter.recordRequest(providerId, config);
      }
      
      // Should be blocked immediately
      let allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(false);
      
      // Wait for refill (100ms = 1 token at 10 req/sec)
      await new Promise((resolve) => setTimeout(resolve, 150));
      
      // Should allow one more request after refill
      allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(true);
    });
  });

  describe('Multiple Providers', () => {
    it('should track limits separately per provider', async () => {
      const config1: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 1,
      };

      const config2: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      // Exhaust provider 1
      await rateLimiter.checkLimit('provider1', config1);
      await rateLimiter.recordRequest('provider1', config1);
      
      // Provider 1 should be blocked
      let allowed = await rateLimiter.checkLimit('provider1', config1);
      expect(allowed).toBe(false);
      
      // Provider 2 should still be allowed
      allowed = await rateLimiter.checkLimit('provider2', config2);
      expect(allowed).toBe(true);
    });

    it('should handle concurrent requests to different providers', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const promises = [
        rateLimiter.checkLimit('provider1', config),
        rateLimiter.checkLimit('provider2', config),
        rateLimiter.checkLimit('provider3', config),
      ];

      const results = await Promise.all(promises);
      
      expect(results.every((r) => r === true)).toBe(true);
    });
  });

  describe('Burst Handling', () => {
    it('should allow burst requests up to burstSize', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 5,
      };

      const providerId = 'test-provider';
      
      // Should allow 5 burst requests immediately
      for (let i = 0; i < 5; i++) {
        const allowed = await rateLimiter.checkLimit(providerId, config);
        expect(allowed).toBe(true);
        await rateLimiter.recordRequest(providerId, config);
      }
      
      // 6th request should be blocked
      const allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(false);
    });

    it('should handle burst then steady-state requests', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 2,
        burstSize: 4,
      };

      const providerId = 'test-provider';
      
      // Use burst
      for (let i = 0; i < 4; i++) {
        await rateLimiter.checkLimit(providerId, config);
        await rateLimiter.recordRequest(providerId, config);
      }
      
      // Should be blocked
      let allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(false);
      
      // Wait for steady-state refill (500ms = 1 token at 2 req/sec)
      await new Promise((resolve) => setTimeout(resolve, 550));
      
      // Should allow one more request
      allowed = await rateLimiter.checkLimit(providerId, config);
      expect(allowed).toBe(true);
    });
  });

  describe('Wait Time Calculation', () => {
    it('should calculate wait time when rate limited', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const providerId = 'test-provider';
      
      // Exhaust all tokens
      for (let i = 0; i < 10; i++) {
        await rateLimiter.checkLimit(providerId, config);
        await rateLimiter.recordRequest(providerId, config);
      }
      
      const waitTime = await rateLimiter.getWaitTime(providerId, config);
      
      expect(waitTime).toBeGreaterThan(0);
      expect(waitTime).toBeLessThanOrEqual(1000); // Max 1 second for 10 req/sec
    });

    it('should return 0 wait time when under limit', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const providerId = 'test-provider';
      
      const waitTime = await rateLimiter.getWaitTime(providerId, config);
      
      expect(waitTime).toBe(0);
    });
  });

  describe('State Management', () => {
    it('should persist rate limit state across checks', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const providerId = 'test-provider';
      
      // Make some requests
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(providerId, config);
        await rateLimiter.recordRequest(providerId, config);
      }
      
      // Get state
      const state = await rateLimiter.getState(providerId);
      
      expect(state).toBeDefined();
      expect(state.requestsInWindow).toBe(5);
      expect(state.tokensRemaining).toBe(5);
    });

    it('should reset state after window expires', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1,
        burstSize: 1,
      };

      const providerId = 'test-provider';
      
      // Exhaust limit
      await rateLimiter.checkLimit(providerId, config);
      await rateLimiter.recordRequest(providerId, config);
      
      // Wait for window to reset
      await new Promise((resolve) => setTimeout(resolve, 1100));
      
      // State should be reset
      const state = await rateLimiter.getState(providerId);
      
      expect(state.requestsInWindow).toBe(0);
      expect(state.tokensRemaining).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero rate limit', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 0,
        burstSize: 0,
      };

      const providerId = 'test-provider';
      
      const allowed = await rateLimiter.checkLimit(providerId, config);
      
      expect(allowed).toBe(false);
    });

    it('should handle very high rate limits', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 1000,
        burstSize: 2000,
      };

      const providerId = 'test-provider';
      
      // Should handle high limits without issues
      for (let i = 0; i < 100; i++) {
        const allowed = await rateLimiter.checkLimit(providerId, config);
        expect(allowed).toBe(true);
        await rateLimiter.recordRequest(providerId, config);
      }
    });

    it('should handle concurrent checks for same provider', async () => {
      const config: RateLimitConfig = {
        requestsPerSecond: 10,
        burstSize: 10,
      };

      const providerId = 'test-provider';
      
      // Make concurrent requests
      const promises = Array.from({ length: 20 }, () =>
        rateLimiter.checkLimit(providerId, config),
      );

      const results = await Promise.all(promises);
      
      // Some should succeed, some should fail
      const allowed = results.filter((r) => r === true).length;
      expect(allowed).toBeLessThanOrEqual(10);
    });
  });
});
