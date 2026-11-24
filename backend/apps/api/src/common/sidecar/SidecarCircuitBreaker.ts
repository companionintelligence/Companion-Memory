import { ServiceUnavailableException } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SidecarCircuitSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  shortCircuitedCount: number;
  lastFailureAt: number | null;
  lastError: string | null;
  openedAt: number | null;
}

export interface SidecarCircuitBreakerOptions {
  name: string;
  /** Number of consecutive transient failures before opening the circuit (default: 3). */
  failureThreshold?: number;
  /** Cooldown in ms before an OPEN circuit allows a HALF_OPEN probe (default: 30_000). */
  resetTimeoutMs?: number;
  /** Predicate deciding whether a thrown error counts toward opening the circuit. */
  isTransientError?: (error: unknown) => boolean;
  now?: () => number;
}

function defaultIsTransientError(error: unknown): boolean {
  if (error instanceof ServiceUnavailableException) {
    return true;
  }

  if (error instanceof Error) {
    // 4xx Nest HTTP exceptions other than 503 (e.g. UnauthorizedException, BadRequestException)
    // represent caller/auth errors rather than sidecar unavailability.
    const status = (error as { getStatus?: () => number }).getStatus?.();
    if (typeof status === 'number') {
      return status >= 500;
    }

    return true;
  }

  return true;
}

/**
 * Deterministic `CLOSED` -> `OPEN` -> `HALF_OPEN` circuit breaker for Python
 * sidecars (`hbpe` :8001, `summary` :8002).
 *
 * Prevents cascading 10-second socket timeouts across GraphQL queries when a
 * sidecar container is down or restarting, while surfacing explicit circuit
 * telemetry (`getSnapshot()`) so operators can distinguish "sidecar unreachable"
 * from "no predictions available".
 */
export class SidecarCircuitBreaker {
  private readonly name: string;

  private readonly failureThreshold: number;

  private readonly resetTimeoutMs: number;

  private readonly isTransientError: (error: unknown) => boolean;

  private readonly now: () => number;

  private state: CircuitState = 'CLOSED';

  private consecutiveFailures = 0;

  private shortCircuitedCount = 0;

  private lastFailureAt: number | null = null;

  private lastError: string | null = null;

  private openedAt: number | null = null;

  private halfOpenProbeInFlight = false;

  constructor(options: SidecarCircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.resetTimeoutMs = Math.max(100, options.resetTimeoutMs ?? 30_000);
    this.isTransientError = options.isTransientError ?? defaultIsTransientError;
    this.now = options.now ?? Date.now;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const timestamp = this.now();

    if (this.state === 'OPEN') {
      if (this.openedAt !== null && timestamp - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenProbeInFlight = false;
      } else {
        this.shortCircuitedCount += 1;
        throw new ServiceUnavailableException(
          `${this.name} sidecar circuit is OPEN (${this.consecutiveFailures} consecutive failures)`,
        );
      }
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenProbeInFlight) {
      this.shortCircuitedCount += 1;
      throw new ServiceUnavailableException(
        `${this.name} sidecar circuit is HALF_OPEN (probe already in flight)`,
      );
    }

    if (this.state === 'HALF_OPEN') {
      this.halfOpenProbeInFlight = true;
    }

    try {
      const result = await operation();
      this.onSuccess();

      return result;
    } catch (err: unknown) {
      this.onFailure(err);
      throw err;
    }
  }

  getSnapshot(): SidecarCircuitSnapshot {
    // Refresh OPEN -> HALF_OPEN visibility if cooldown has elapsed.
    if (
      this.state === 'OPEN' &&
      this.openedAt !== null &&
      this.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      this.state = 'HALF_OPEN';
      this.halfOpenProbeInFlight = false;
    }

    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      shortCircuitedCount: this.shortCircuitedCount,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      openedAt: this.openedAt,
    };
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.shortCircuitedCount = 0;
    this.lastFailureAt = null;
    this.lastError = null;
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
  }

  private onSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
  }

  private onFailure(err: unknown): void {
    this.halfOpenProbeInFlight = false;

    if (!this.isTransientError(err)) {
      return;
    }

    const timestamp = this.now();
    this.consecutiveFailures += 1;
    this.lastFailureAt = timestamp;
    this.lastError = err instanceof Error ? err.message : String(err);

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = timestamp;
    }
  }
}
