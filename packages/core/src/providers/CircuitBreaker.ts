/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';

/**
 * Circuit breaker states.
 */
export enum CircuitState {
  /** Normal operation - requests pass through */
  CLOSED = 'closed',
  /** Failing fast - rejecting requests */
  OPEN = 'open',
  /** Testing if service recovered */
  HALF_OPEN = 'half-open',
}

/**
 * Configuration for circuit breaker behavior.
 */
export interface CircuitBreakerConfig {
  /** Trip after N consecutive failures */
  failureThreshold: number;
  /** Close after N consecutive successes */
  successThreshold: number;
  /** Wait this long before trying half-open */
  timeoutMs: number;
  /** Max test calls in half-open state */
  halfOpenMaxCalls: number;
}

/**
 * Metrics collected by circuit breaker.
 */
export interface CircuitBreakerMetrics {
  totalCalls: number;
  rejectedCalls: number;
  successfulCalls: number;
  failedCalls: number;
  stateChanges: number;
}

/**
 * Error thrown when circuit breaker is open.
 */
export class CircuitBreakerOpenError extends Error {
  constructor(
    message: string,
    public readonly timeUntilReset: number,
  ) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Circuit breaker pattern implementation.
 *
 * Prevents cascade failures by failing fast when a service is struggling,
 * then automatically testing recovery before fully reopening.
 */
export class CircuitBreaker {
  private _state = CircuitState.CLOSED;
  private _failures = 0;
  private _successes = 0;
  private _halfOpenCalls = 0;
  private _lastFailureTime = 0;
  private _metrics: CircuitBreakerMetrics = {
    totalCalls: 0,
    rejectedCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    stateChanges: 0,
  };

  constructor(
    private _name: string,
    private _config: CircuitBreakerConfig,
  ) {}

  /**
   * Execute a function with circuit breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can execute
    if (this._state === CircuitState.OPEN) {
      if (this._shouldAttemptReset()) {
        this._transitionTo(CircuitState.HALF_OPEN);
      } else {
        this._metrics.rejectedCalls++;
        const timeUntilReset = this._getTimeUntilReset();
        throw new CircuitBreakerOpenError(
          `Circuit breaker '${this._name}' is OPEN. ` +
            `Next attempt in ${timeUntilReset}ms`,
          timeUntilReset,
        );
      }
    }

    if (
      this._state === CircuitState.HALF_OPEN &&
      this._halfOpenCalls >= this._config.halfOpenMaxCalls
    ) {
      this._metrics.rejectedCalls++;
      throw new CircuitBreakerOpenError(
        `Circuit breaker '${this._name}' at capacity in HALF_OPEN state`,
        0,
      );
    }

    // Track half-open call
    if (this._state === CircuitState.HALF_OPEN) {
      this._halfOpenCalls++;
    }

    this._metrics.totalCalls++;

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  /**
   * Get current circuit state.
   */
  getState(): CircuitState {
    return this._state;
  }

  /**
   * Get collected metrics.
   */
  getMetrics(): CircuitBreakerMetrics {
    return { ...this._metrics };
  }

  /**
   * Force circuit breaker to open (manual trip).
   */
  forceOpen(): void {
    this._transitionTo(CircuitState.OPEN);
  }

  /**
   * Force circuit breaker to close (manual reset).
   */
  forceClose(): void {
    this._transitionTo(CircuitState.CLOSED);
    this._failures = 0;
    this._successes = 0;
    this._halfOpenCalls = 0;
  }

  /**
   * Get current state info for debugging.
   */
  getDebugInfo(): {
    state: CircuitState;
    failures: number;
    successes: number;
    halfOpenCalls: number;
    lastFailureTime: number;
    timeUntilReset: number;
  } {
    return {
      state: this._state,
      failures: this._failures,
      successes: this._successes,
      halfOpenCalls: this._halfOpenCalls,
      lastFailureTime: this._lastFailureTime,
      timeUntilReset: this._getTimeUntilReset(),
    };
  }

  // ==========================================================================
  // Private methods
  // ==========================================================================

  private _onSuccess(): void {
    this._metrics.successfulCalls++;

    switch (this._state) {
      case CircuitState.HALF_OPEN:
        this._successes++;
        if (this._successes >= this._config.successThreshold) {
          this._transitionTo(CircuitState.CLOSED);
        }
        break;
      case CircuitState.CLOSED:
        this._failures = 0; // Reset failure count on success
        break;
    }
  }

  private _onFailure(): void {
    this._metrics.failedCalls++;

    switch (this._state) {
      case CircuitState.HALF_OPEN:
        this._transitionTo(CircuitState.OPEN);
        break;
      case CircuitState.CLOSED:
        this._failures++;
        if (this._failures >= this._config.failureThreshold) {
          this._transitionTo(CircuitState.OPEN);
        }
        break;
    }
  }

  private _transitionTo(newState: CircuitState): void {
    if (this._state !== newState) {
      const oldState = this._state;
      this._state = newState;
      this._metrics.stateChanges++;

      // Reset counters on state change
      if (newState === CircuitState.OPEN) {
        this._lastFailureTime = Date.now();
        this._halfOpenCalls = 0;
      } else if (newState === CircuitState.CLOSED) {
        this._failures = 0;
        this._successes = 0;
        this._halfOpenCalls = 0;
      } else if (newState === CircuitState.HALF_OPEN) {
        this._successes = 0;
        this._halfOpenCalls = 0;
      }

      debugLogger.log(
        `[CircuitBreaker:${this._name}] ${oldState} -> ${newState}`,
      );
    }
  }

  private _shouldAttemptReset(): boolean {
    return Date.now() - this._lastFailureTime >= this._config.timeoutMs;
  }

  private _getTimeUntilReset(): number {
    if (this._state !== CircuitState.OPEN) return 0;
    return Math.max(0, this._config.timeoutMs - (Date.now() - this._lastFailureTime));
  }
}

/**
 * Create a circuit breaker with sensible defaults.
 */
export function createCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>,
): CircuitBreaker {
  const fullConfig: CircuitBreakerConfig = {
    failureThreshold: 5,
    successThreshold: 3,
    timeoutMs: 30000,
    halfOpenMaxCalls: 2,
    ...config,
  };
  return new CircuitBreaker(name, fullConfig);
}
