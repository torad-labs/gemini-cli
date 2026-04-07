/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { CostTracker, estimateTokens, formatCost } from '../CostTracker.js';

describe('CostTracker', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe('basic tracking', () => {
    it('tracks a record with calculated cost', () => {
      const record = tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      expect(record.cost).toBeGreaterThan(0);
      expect(record.cost).toBeCloseTo(0.0125, 4); // (1000 * 0.005 + 500 * 0.015) / 1000
    });

    it('tracks free models with zero cost', () => {
      const record = tracker.track({
        timestamp: new Date(),
        providerId: 'ollama',
        modelId: 'llama3.2',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      expect(record.cost).toBe(0);
    });

    it('tracks unknown models with zero cost', () => {
      const record = tracker.track({
        timestamp: new Date(),
        providerId: 'unknown',
        modelId: 'unknown-model',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      expect(record.cost).toBe(0);
    });
  });

  describe('cost calculation', () => {
    it('calculates total cost correctly', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 2000,
        outputTokens: 1000,
        duration: 2000,
        success: true,
      });

      const total = tracker.getTotalCost();
      // (1000*0.005 + 500*0.015 + 2000*0.005 + 1000*0.015) / 1000 = 0.0375
      expect(total).toBeCloseTo(0.0375, 4);
    });

    it('calculates cost by provider', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: new Date(),
        providerId: 'ollama',
        modelId: 'llama3.2',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const byProvider = tracker.getCostByProvider();
      expect(byProvider.size).toBe(2);

      const openai = byProvider.get('openai');
      expect(openai?.cost).toBeGreaterThan(0);
      expect(openai?.requests).toBe(1);

      const ollama = byProvider.get('ollama');
      expect(ollama?.cost).toBe(0);
    });

    it('calculates cost by model', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const byModel = tracker.getCostByModel();
      expect(byModel.size).toBe(2);

      // gpt-4 should cost more than gpt-4o
      const gpt4 = byModel.get('gpt-4');
      const gpt4o = byModel.get('gpt-4o');
      expect(gpt4!.cost).toBeGreaterThan(gpt4o!.cost);
    });

    it('calculates daily costs', () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      tracker.track({
        timestamp: yesterday,
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: today,
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const daily = tracker.getDailyCosts();
      expect(daily.size).toBe(2);

      // Each day should have the same cost (same input/output)
      const todayKey = today.toISOString().split('T')[0]!;
      const yesterdayKey = yesterday.toISOString().split('T')[0]!;
      expect(daily.get(todayKey)).toBe(daily.get(yesterdayKey));
    });
  });

  describe('filtering', () => {
    it('filters by provider', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: new Date(),
        providerId: 'ollama',
        modelId: 'llama3.2',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const openaiCost = tracker.getTotalCost({ providerId: 'openai' });
      expect(openaiCost).toBeGreaterThan(0);

      const ollamaCost = tracker.getTotalCost({ providerId: 'ollama' });
      expect(ollamaCost).toBe(0);
    });

    it('filters by date range', () => {
      const oldDate = new Date('2024-01-01');
      const newDate = new Date('2024-06-01');

      tracker.track({
        timestamp: oldDate,
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      tracker.track({
        timestamp: newDate,
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const sinceCost = tracker.getTotalCost({ since: new Date('2024-05-01') });
      expect(sinceCost).toBeGreaterThan(0);

      const untilCost = tracker.getTotalCost({ until: new Date('2024-02-01') });
      expect(untilCost).toBeGreaterThan(0);

      // Range that excludes both
      const emptyRange = tracker.getTotalCost({
        since: new Date('2024-02-01'),
        until: new Date('2024-04-01'),
      });
      expect(emptyRange).toBe(0);
    });
  });

  describe('custom pricing', () => {
    it('allows custom pricing', () => {
      tracker.setPricing({
        'custom-model': {
          inputPricePer1k: 0.01,
          outputPricePer1k: 0.02,
          currency: 'USD',
        },
      });

      const record = tracker.track({
        timestamp: new Date(),
        providerId: 'custom',
        modelId: 'custom-model',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      // (1000 * 0.01 + 500 * 0.02) / 1000 = 0.02
      expect(record.cost).toBeCloseTo(0.02, 4);
    });
  });

  describe('persistence', () => {
    it('exports and imports records', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const exported = tracker.export();
      expect(exported).toHaveLength(1);

      const newTracker = new CostTracker();
      newTracker.import(exported);
      expect(newTracker.getTotalCost()).toBe(tracker.getTotalCost());
    });

    it('clears all records', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      expect(tracker.getTotalCost()).toBeGreaterThan(0);
      tracker.clear();
      expect(tracker.getTotalCost()).toBe(0);
    });
  });

  describe('summary', () => {
    it('provides comprehensive summary', () => {
      tracker.track({
        timestamp: new Date(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        operation: 'generate',
        inputTokens: 1000,
        outputTokens: 500,
        duration: 1000,
        success: true,
      });

      const summary = tracker.getSummary();
      expect(summary.totalCost).toBeGreaterThan(0);
      expect(summary.totalRequests).toBe(1);
      expect(summary.totalTokens.total).toBe(1500);
      expect(summary.byProvider.has('openai')).toBe(true);
      expect(summary.byModel.has('gpt-4o')).toBe(true);
    });
  });
});

describe('estimateTokens', () => {
  it('estimates tokens for short text', () => {
    const tokens = estimateTokens('Hello world');
    expect(tokens).toBe(3); // ceil(11 / 4) = 3
  });

  it('estimates tokens for longer text', () => {
    const tokens = estimateTokens('The quick brown fox jumps over the lazy dog');
    expect(tokens).toBe(11); // ceil(43 / 4) = 11
  });

  it('returns 0 for empty string', () => {
    const tokens = estimateTokens('');
    expect(tokens).toBe(0); // ceil(0 / 4) = 0
  });
});

describe('formatCost', () => {
  it('formats zero cost', () => {
    expect(formatCost(0)).toBe('0.00 USD');
  });

  it('formats small cost', () => {
    expect(formatCost(0.0001)).toBe('< USD 0.001');
  });

  it('formats normal cost', () => {
    expect(formatCost(0.12345)).toBe('USD 0.1235');
  });

  it('formats with custom currency', () => {
    expect(formatCost(0.5, 'EUR')).toBe('EUR 0.5000');
  });
});
