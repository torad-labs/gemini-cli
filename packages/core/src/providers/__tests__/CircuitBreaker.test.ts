/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitState, CircuitBreakerOpenError } from '../CircuitBreaker.js';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 1000,
      halfOpenMaxCalls: 2,
    });
  });

  describe('initial state', () => {
    it('starts in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('executes function normally when closed', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await circuitBreaker.execute(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('state transitions', () => {
    it('transitions to OPEN after threshold failures', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('rejects requests when OPEN', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      // Should reject without calling function
      const succeedingFn = vi.fn().mockResolvedValue('success');
      await expect(circuitBreaker.execute(succeedingFn)).rejects.toThrow(
        CircuitBreakerOpenError,
      );

      expect(succeedingFn).not.toHaveBeenCalled();
    });

    it('includes time until reset in error message', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      try {
        await circuitBreaker.execute(fn);
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          expect(error.timeUntilReset).toBeGreaterThan(0);
          expect(error.timeUntilReset).toBeLessThanOrEqual(1000);
        } else {
          throw error;
        }
      }
    });
  });

  describe('HALF_OPEN state', () => {
    it('transitions to HALF_OPEN after timeout', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Next attempt should transition to HALF_OPEN
      const succeedingFn = vi.fn().mockResolvedValue('success');
      await circuitBreaker.execute(succeedingFn);

      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('returns to OPEN on failure in HALF_OPEN', async () => {
      // Trip circuit
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch {
          // Expected
        }
      }

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Fail in HALF_OPEN
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('returns to CLOSED after success threshold', async () => {
      // Trip circuit
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch {
          // Expected
        }
      }

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Succeed twice
      const successFn = vi.fn().mockResolvedValue('success');
      await circuitBreaker.execute(successFn);
      await circuitBreaker.execute(successFn);

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('metrics', () => {
    it('tracks successful calls', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      await circuitBreaker.execute(fn);

      expect(circuitBreaker.getMetrics().successfulCalls).toBe(1);
    });

    it('tracks failed calls', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try {
        await circuitBreaker.execute(fn);
      } catch {
        // Expected
      }

      expect(circuitBreaker.getMetrics().failedCalls).toBe(1);
    });

    it('tracks rejected calls when OPEN', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      // Should reject without executing
      const succeedingFn = vi.fn().mockResolvedValue('success');
      try {
        await circuitBreaker.execute(succeedingFn);
      } catch {
        // Expected
      }

      expect(circuitBreaker.getMetrics().rejectedCalls).toBe(1);
    });

    it('tracks state changes', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit (1 change: CLOSED -> OPEN)
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      expect(circuitBreaker.getMetrics().stateChanges).toBe(1);
    });
  });

  describe('manual control', () => {
    it('can be forced OPEN', () => {
      circuitBreaker.forceOpen();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('can be forced CLOSED', async () => {
      // Trip circuit first
      const failFn = vi.fn().mockRejectedValue(new Error('fail'));
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(failFn);
        } catch {
          // Expected
        }
      }

      circuitBreaker.forceClose();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);

      // Should allow execution
      const successFn = vi.fn().mockResolvedValue('success');
      await circuitBreaker.execute(successFn);
      expect(successFn).toHaveBeenCalled();
    });
  });

  describe('debug info', () => {
    it('provides debug information', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      // Trip circuit
      for (let i = 0; i < 3; i++) {
        try {
          await circuitBreaker.execute(fn);
        } catch {
          // Expected
        }
      }

      const debugInfo = circuitBreaker.getDebugInfo();
      expect(debugInfo.state).toBe(CircuitState.OPEN);
      expect(debugInfo.failures).toBe(3);
      expect(debugInfo.timeUntilReset).toBeGreaterThan(0);
    });
  });
});
