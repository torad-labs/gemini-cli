/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cost tracking for provider usage.
 */

export interface CostRecord {
  timestamp: Date;
  providerId: string;
  modelId: string;
  operation: 'generate' | 'stream' | 'embed' | 'count';
  inputTokens: number;
  outputTokens: number;
  duration: number;
  cost: number;
  success: boolean;
}

export interface PricingConfig {
  [modelId: string]: {
    inputPricePer1k: number;
    outputPricePer1k: number;
    currency: string;
  };
}

export interface CostByProvider {
  cost: number;
  tokens: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostByModel {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Track costs for provider operations.
 */
export class CostTracker {
  private _records: CostRecord[] = [];
  private _pricing: PricingConfig = {};

  // Built-in pricing for known models
  private _defaultPricing: PricingConfig = {
    'gpt-4': { inputPricePer1k: 0.03, outputPricePer1k: 0.06, currency: 'USD' },
    'gpt-4o': { inputPricePer1k: 0.005, outputPricePer1k: 0.015, currency: 'USD' },
    'gpt-4o-mini': { inputPricePer1k: 0.00015, outputPricePer1k: 0.0006, currency: 'USD' },
    'llama3.2': { inputPricePer1k: 0, outputPricePer1k: 0, currency: 'USD' },
    'llama3.1': { inputPricePer1k: 0, outputPricePer1k: 0, currency: 'USD' },
  };

  constructor() {
    this._pricing = { ...this._defaultPricing };
  }

  /**
   * Track a usage record and calculate cost.
   */
  track(record: Omit<CostRecord, 'cost'>): CostRecord {
    const cost = this._calculateCost(record);
    const fullRecord: CostRecord = { ...record, cost };
    this._records.push(fullRecord);
    return fullRecord;
  }

  /**
   * Calculate cost based on tokens and model pricing.
   */
  private _calculateCost(
    record: Pick<CostRecord, 'modelId' | 'inputTokens' | 'outputTokens'>,
  ): number {
    const pricing = this._pricing[record.modelId];
    if (!pricing) {
      return 0; // Unknown pricing
    }

    const inputCost = (record.inputTokens / 1000) * pricing.inputPricePer1k;
    const outputCost = (record.outputTokens / 1000) * pricing.outputPricePer1k;

    return Number((inputCost + outputCost).toFixed(6)); // 6 decimal places
  }

  /**
   * Get total cost for all tracked operations.
   */
  getTotalCost(options?: {
    since?: Date;
    until?: Date;
    providerId?: string;
    modelId?: string;
    operation?: CostRecord['operation'];
  }): number {
    return Number(
      this._filterRecords(options)
        .reduce((sum, r) => sum + r.cost, 0)
        .toFixed(6),
    );
  }

  /**
   * Get total tokens processed.
   */
  getTotalTokens(options?: {
    since?: Date;
    until?: Date;
    providerId?: string;
  }): { input: number; output: number; total: number } {
    const records = this._filterRecords(options);
    const input = records.reduce((sum, r) => sum + r.inputTokens, 0);
    const output = records.reduce((sum, r) => sum + r.outputTokens, 0);
    return { input, output, total: input + output };
  }

  /**
   * Get cost breakdown by provider.
   */
  getCostByProvider(): Map<string, CostByProvider> {
    const result = new Map<string, CostByProvider>();

    for (const record of this._records) {
      const current = result.get(record.providerId) ?? {
        cost: 0,
        tokens: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      const totalTokens = record.inputTokens + record.outputTokens;
      result.set(record.providerId, {
        cost: Number((current.cost + record.cost).toFixed(6)),
        tokens: current.tokens + totalTokens,
        requests: current.requests + 1,
        inputTokens: current.inputTokens + record.inputTokens,
        outputTokens: current.outputTokens + record.outputTokens,
      });
    }

    return result;
  }

  /**
   * Get cost breakdown by model.
   */
  getCostByModel(): Map<string, CostByModel> {
    const result = new Map<string, CostByModel>();

    for (const record of this._records) {
      const current = result.get(record.modelId) ?? {
        cost: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      const totalTokens = record.inputTokens + record.outputTokens;
      result.set(record.modelId, {
        cost: Number((current.cost + record.cost).toFixed(6)),
        tokens: current.tokens + totalTokens,
        inputTokens: current.inputTokens + record.inputTokens,
        outputTokens: current.outputTokens + record.outputTokens,
      });
    }

    return result;
  }

  /**
   * Get daily cost breakdown.
   */
  getDailyCosts(): Map<string, number> {
    const result = new Map<string, number>();

    for (const record of this._records) {
      const date = record.timestamp.toISOString().split('T')[0]!;
      const current = result.get(date) ?? 0;
      result.set(date, Number((current + record.cost).toFixed(6)));
    }

    return result;
  }

  /**
   * Get recent records (last N).
   */
  getRecentRecords(count: number): CostRecord[] {
    return this._records.slice(-count);
  }

  /**
   * Set custom pricing for models.
   */
  setPricing(pricing: PricingConfig): void {
    this._pricing = { ...this._defaultPricing, ...pricing };
  }

  /**
   * Get current pricing configuration.
   */
  getPricing(): PricingConfig {
    return { ...this._pricing };
  }

  /**
   * Export all records.
   */
  export(): CostRecord[] {
    return [...this._records];
  }

  /**
   * Import records (for persistence).
   */
  import(records: CostRecord[]): void {
    this._records = records.map((r) => ({
      ...r,
      timestamp: new Date(r.timestamp),
    }));
  }

  /**
   * Clear all tracked data.
   */
  clear(): void {
    this._records = [];
  }

  /**
   * Get summary statistics.
   */
  getSummary(): {
    totalCost: number;
    totalRequests: number;
    totalTokens: { input: number; output: number; total: number };
    byProvider: Map<string, CostByProvider>;
    byModel: Map<string, CostByModel>;
    daily: Map<string, number>;
  } {
    return {
      totalCost: this.getTotalCost(),
      totalRequests: this._records.length,
      totalTokens: this.getTotalTokens(),
      byProvider: this.getCostByProvider(),
      byModel: this.getCostByModel(),
      daily: this.getDailyCosts(),
    };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private _filterRecords(options?: {
    since?: Date;
    until?: Date;
    providerId?: string;
    modelId?: string;
    operation?: CostRecord['operation'];
  }): CostRecord[] {
    return this._records.filter((r) => {
      if (options?.since && r.timestamp < options.since) return false;
      if (options?.until && r.timestamp > options.until) return false;
      if (options?.providerId && r.providerId !== options.providerId) return false;
      if (options?.modelId && r.modelId !== options.modelId) return false;
      if (options?.operation && r.operation !== options.operation) return false;
      return true;
    });
  }
}

/**
 * Estimate tokens from text (rough approximation).
 */
export function estimateTokens(text: string): number {
  // GPT models: ~4 chars per token on average
  return Math.ceil(text.length / 4);
}

/**
 * Format cost for display.
 */
export function formatCost(cost: number, currency = 'USD'): string {
  if (cost === 0) return `0.00 ${currency}`;
  if (cost < 0.001) return `< ${currency} 0.001`;
  return `${currency} ${cost.toFixed(4)}`;
}
