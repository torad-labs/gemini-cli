# Phase 3: Advanced Provider Features

## Overview
Build production-grade resilience and observability features into the Provider-as-a-Service layer.

**Duration**: 3-4 weeks  
**Goal**: Production-ready provider management with circuit breakers, auto-failover, and cost tracking  
**Success Criteria**: Zero-downtime provider switching, automatic failure recovery, accurate cost tracking

---

## Task 3.1: Circuit Breaker Pattern

**Purpose**: Prevent cascade failures when a provider is struggling

### Implementation

**File**: `packages/core/src/providers/CircuitBreaker.ts`

```typescript
export enum CircuitState {
  CLOSED = 'closed',     // Normal operation
  OPEN = 'open',         // Failing fast, rejecting requests
  HALF_OPEN = 'half-open' // Testing if recovered
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Trip after N consecutive failures
  successThreshold: number;      // Close after N consecutive successes
  timeoutMs: number;             // Wait before trying half-open
  halfOpenMaxCalls: number;      // Max test calls in half-open state
  monitorIntervalMs: number;     // How often to check state
}

export class CircuitBreaker {
  private _state = CircuitState.CLOSED;
  private _failures = 0;
  private _successes = 0;
  private _halfOpenCalls = 0;
  private _lastFailureTime = 0;
  private _metrics = {
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

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can execute
    if (this._state === CircuitState.OPEN) {
      if (this._shouldAttemptReset()) {
        this._transitionTo(CircuitState.HALF_OPEN);
      } else {
        this._metrics.rejectedCalls++;
        throw new CircuitBreakerOpenError(
          `Circuit breaker '${this._name}' is OPEN. ` +
          `Next attempt in ${this._getTimeUntilReset()}ms`
        );
      }
    }

    if (this._state === CircuitState.HALF_OPEN && 
        this._halfOpenCalls >= this._config.halfOpenMaxCalls) {
      this._metrics.rejectedCalls++;
      throw new CircuitBreakerOpenError(
        `Circuit breaker '${this._name}' at capacity in HALF_OPEN state`
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

  getState(): CircuitState {
    return this._state;
  }

  getMetrics() {
    return { ...this._metrics };
  }

  forceOpen(): void {
    this._transitionTo(CircuitState.OPEN);
  }

  forceClose(): void {
    this._transitionTo(CircuitState.CLOSED);
    this._failures = 0;
    this._successes = 0;
  }

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
        `[CircuitBreaker:${this._name}] ${oldState} -> ${newState}`
      );
    }
  }

  private _shouldAttemptReset(): boolean {
    return Date.now() - this._lastFailureTime >= this._config.timeoutMs;
  }

  private _getTimeUntilReset(): number {
    return Math.max(0, this._config.timeoutMs - (Date.now() - this._lastFailureTime));
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}
```

**Integration with BaseProviderAdapter**:

```typescript
export abstract class BaseProviderAdapter implements IProviderAdapter {
  protected _circuitBreaker?: CircuitBreaker;

  protected async _withRetryAndMetrics<T>(
    operation: string,
    requestId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Wrap with circuit breaker if configured
    if (this._circuitBreaker) {
      return this._circuitBreaker.execute(() =>
        this._executeWithRetry(operation, requestId, fn)
      );
    }
    return this._executeWithRetry(operation, requestId, fn);
  }

  getCircuitState(): CircuitState | undefined {
    return this._circuitBreaker?.getState();
  }
}
```

---

## Task 3.2: Automatic Failover

**Purpose**: Automatically switch to healthy provider when current one fails

### Implementation

**Enhance ProviderService**:

```typescript
export class ProviderService implements IProviderService {
  private _consecutiveErrors = 0;
  private _lastError?: Error;
  private _failoverInProgress = false;

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    return this._executeWithFailover(() =>
      this._currentProvider!.generateContent(request, userPromptId, role)
    );
  }

  private async _executeWithFailover<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const config = this._configService?.getEffectiveConfig().global;
    const autoFailover = config?.autoFailover ?? false;
    const threshold = config?.failoverThreshold ?? 3;

    try {
      const result = await fn();
      
      // Reset error count on success
      if (this._consecutiveErrors > 0) {
        this._consecutiveErrors = 0;
        debugLogger.log('[ProviderService] Error count reset after success');
      }
      
      return result;
    } catch (error) {
      this._consecutiveErrors++;
      this._lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should failover
      if (autoFailover && 
          this._consecutiveErrors >= threshold && 
          !this._failoverInProgress) {
        const failovered = await this._tryFailover();
        if (failovered) {
          // Retry with new provider
          return fn();
        }
      }

      throw error;
    }
  }

  private async _tryFailover(): Promise<boolean> {
    if (this._failoverInProgress) {
      return false;
    }

    this._failoverInProgress = true;
    const failedProvider = this._currentProvider;

    try {
      debugLogger.warn(
        `[ProviderService] Initiating failover from ${failedProvider?.id} ` +
        `after ${this._consecutiveErrors} consecutive errors`
      );

      const bestProvider = this.getBestProvider();
      
      if (!bestProvider || bestProvider.id === failedProvider?.id) {
        debugLogger.warn('[ProviderService] No alternative provider available for failover');
        return false;
      }

      // Emit failover event
      this._eventBus.emit('failover', {
        from: failedProvider,
        to: bestProvider,
        reason: this._lastError?.message ?? 'Unknown error',
        consecutiveErrors: this._consecutiveErrors,
      });

      // Switch provider
      await this.switchProvider(bestProvider.id);
      
      // Reset error count
      this._consecutiveErrors = 0;
      
      debugLogger.log(
        `[ProviderService] Failover complete: ${failedProvider?.id} -> ${bestProvider.id}`
      );
      
      return true;
    } catch (failoverError) {
      debugLogger.error('[ProviderService] Failover failed:', failoverError);
      return false;
    } finally {
      this._failoverInProgress = false;
    }
  }

  // Event subscription
  onFailover(
    handler: (event: {
      from: IProviderAdapter | null;
      to: IProviderAdapter;
      reason: string;
      consecutiveErrors: number;
    }) => void
  ): Unsubscribe {
    this._eventBus.on('failover', handler);
    return () => this._eventBus.off('failover', handler);
  }
}
```

---

## Task 3.3: Cost Tracking

**Purpose**: Track usage costs per provider for budgeting and optimization

### Implementation

**File**: `packages/core/src/providers/CostTracker.ts`

```typescript
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

export class CostTracker {
  private _records: CostRecord[] = [];
  private _pricing: PricingConfig = {};

  // Built-in pricing for known providers
  private _defaultPricing: PricingConfig = {
    'gpt-4': { inputPricePer1k: 0.03, outputPricePer1k: 0.06, currency: 'USD' },
    'gpt-4o': { inputPricePer1k: 0.005, outputPricePer1k: 0.015, currency: 'USD' },
    'llama3.2': { inputPricePer1k: 0, outputPricePer1k: 0, currency: 'USD' }, // Local = free
  };

  constructor() {
    this._pricing = { ...this._defaultPricing };
  }

  track(record: Omit<CostRecord, 'cost'>): CostRecord {
    const cost = this._calculateCost(record);
    const fullRecord: CostRecord = { ...record, cost };
    this._records.push(fullRecord);
    return fullRecord;
  }

  private _calculateCost(record: Pick<CostRecord, 'modelId' | 'inputTokens' | 'outputTokens'>): number {
    const pricing = this._pricing[record.modelId];
    if (!pricing) {
      return 0; // Unknown pricing
    }

    const inputCost = (record.inputTokens / 1000) * pricing.inputPricePer1k;
    const outputCost = (record.outputTokens / 1000) * pricing.outputPricePer1k;
    
    return inputCost + outputCost;
  }

  getTotalCost(options?: {
    since?: Date;
    until?: Date;
    providerId?: string;
    modelId?: string;
  }): number {
    return this._filterRecords(options)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  getCostByProvider(): Map<string, { cost: number; tokens: number; requests: number }> {
    const result = new Map<string, { cost: number; tokens: number; requests: number }>();
    
    for (const record of this._records) {
      const current = result.get(record.providerId) ?? { cost: 0, tokens: 0, requests: 0 };
      result.set(record.providerId, {
        cost: current.cost + record.cost,
        tokens: current.tokens + record.inputTokens + record.outputTokens,
        requests: current.requests + 1,
      });
    }
    
    return result;
  }

  getCostByModel(): Map<string, { cost: number; tokens: number }> {
    const result = new Map<string, { cost: number; tokens: number }>();
    
    for (const record of this._records) {
      const current = result.get(record.modelId) ?? { cost: 0, tokens: 0 };
      result.set(record.modelId, {
        cost: current.cost + record.cost,
        tokens: current.tokens + record.inputTokens + record.outputTokens,
      });
    }
    
    return result;
  }

  getDailyCosts(): Map<string, number> {
    const result = new Map<string, number>();
    
    for (const record of this._records) {
      const date = record.timestamp.toISOString().split('T')[0];
      const current = result.get(date) ?? 0;
      result.set(date, current + record.cost);
    }
    
    return result;
  }

  setPricing(pricing: PricingConfig): void {
    this._pricing = { ...this._defaultPricing, ...pricing };
  }

  export(): CostRecord[] {
    return [...this._records];
  }

  clear(): void {
    this._records = [];
  }

  private _filterRecords(options?: {
    since?: Date;
    until?: Date;
    providerId?: string;
    modelId?: string;
  }): CostRecord[] {
    return this._records.filter(r => {
      if (options?.since && r.timestamp < options.since) return false;
      if (options?.until && r.timestamp > options.until) return false;
      if (options?.providerId && r.providerId !== options.providerId) return false;
      if (options?.modelId && r.modelId !== options.modelId) return false;
      return true;
    });
  }
}
```

**Integration with ProviderService**:

```typescript
export class ProviderService implements IProviderService {
  private _costTracker = new CostTracker();

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const startTime = Date.now();
    const startTokens = await this._estimateInputTokens(request);
    
    try {
      const result = await this._currentProvider!.generateContent(
        request, userPromptId, role
      );
      
      // Track successful call
      this._costTracker.track({
        timestamp: new Date(),
        providerId: this._currentProvider!.id,
        modelId: request.model ?? this._currentProvider!.getDefaultModel(),
        operation: 'generate',
        inputTokens: startTokens,
        outputTokens: this._estimateOutputTokens(result),
        duration: Date.now() - startTime,
        success: true,
      });
      
      return result;
    } catch (error) {
      // Track failed call
      this._costTracker.track({
        timestamp: new Date(),
        providerId: this._currentProvider!.id,
        modelId: request.model ?? this._currentProvider!.getDefaultModel(),
        operation: 'generate',
        inputTokens: startTokens,
        outputTokens: 0,
        duration: Date.now() - startTime,
        success: false,
      });
      throw error;
    }
  }

  getCostSummary(): {
    total: number;
    byProvider: Map<string, number>;
    byModel: Map<string, number>;
    daily: Map<string, number>;
  } {
    return {
      total: this._costTracker.getTotalCost(),
      byProvider: new Map(
        Array.from(this._costTracker.getCostByProvider()).map(([k, v]) => [k, v.cost])
      ),
      byModel: new Map(
        Array.from(this._costTracker.getCostByModel()).map(([k, v]) => [k, v.cost])
      ),
      daily: this._costTracker.getDailyCosts(),
    };
  }
}
```

---

## Task 3.4: Connection Pooling (Optional)

**Purpose**: Manage connection limits for providers with strict rate limits

**Only needed for**: Enterprise providers with connection-based pricing

```typescript
export interface PoolConfig {
  maxConnections: number;
  minConnections: number;
  acquireTimeoutMs: number;
  idleTimeoutMs: number;
  connectionLifetimeMs: number;
}

export class ProviderPool {
  // Implementation for connection pooling
  // Skip for initial release - add later if needed
}
```

---

## Task 3.5: Load Balancing (Optional)

**Purpose**: Distribute traffic across multiple providers

**Implementation**:

```typescript
export type LoadBalancingStrategy = 
  | 'round-robin'
  | 'weighted-response-time'
  | 'least-errors'
  | 'random';

export class LoadBalancer {
  private _providers: WeightedProvider[] = [];
  private _currentIndex = 0;
  private _weights: number[] = [];

  constructor(
    private _strategy: LoadBalancingStrategy,
    providers: IProviderAdapter[],
  ) {
    this._providers = providers.map(p => ({ adapter: p, weight: 1 }));
    this._calculateWeights();
  }

  select(): IProviderAdapter {
    switch (this._strategy) {
      case 'round-robin':
        return this._roundRobin();
      case 'random':
        return this._random();
      case 'weighted-response-time':
        return this._weighted();
      default:
        return this._roundRobin();
    }
  }

  private _roundRobin(): IProviderAdapter {
    const provider = this._providers[this._currentIndex];
    this._currentIndex = (this._currentIndex + 1) % this._providers.length;
    return provider.adapter;
  }

  private _random(): IProviderAdapter {
    const index = Math.floor(Math.random() * this._providers.length);
    return this._providers[index]!.adapter;
  }

  private _weighted(): IProviderAdapter {
    const totalWeight = this._weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    
    for (let i = 0; i < this._weights.length; i++) {
      random -= this._weights[i]!;
      if (random <= 0) {
        return this._providers[i]!.adapter;
      }
    }
    
    return this._providers[0]!.adapter;
  }

  private _calculateWeights(): void {
    // Calculate weights based on strategy
    if (this._strategy === 'weighted-response-time') {
      const latencies = this._providers.map(p => {
        const metrics = p.adapter.getMetrics();
        return metrics.averageLatency || 1000; // Default 1s if no data
      });
      
      // Inverse weighting: faster providers get higher weight
      const inverseLatencies = latencies.map(l => 1 / l);
      const sum = inverseLatencies.reduce((a, b) => a + b, 0);
      this._weights = inverseLatencies.map(l => l / sum);
    } else {
      // Equal weights
      this._weights = this._providers.map(() => 1 / this._providers.length);
    }
  }
}
```

---

## Implementation Order

### Week 1: Circuit Breaker + Failover
```
Day 1-2: CircuitBreaker class
Day 3-4: Integration with BaseProviderAdapter
Day 5: Auto-failover logic in ProviderService
Day 6-7: Testing
```

### Week 2: Cost Tracking
```
Day 1: CostTracker class
Day 2-3: Integration with ProviderService
Day 4: Pricing configuration
Day 5-6: Cost reporting/export
Day 7: Testing
```

### Week 3: Polish + Integration
```
Day 1-2: Event system for monitoring
Day 3-4: Metrics dashboard API
Day 5-6: Documentation
Day 7: End-to-end testing
```

### Week 4 (Optional): Load Balancing
```
Day 1-3: LoadBalancer implementation
Day 4-5: Multi-provider routing
Day 6-7: Testing
```

---

## Configuration

**Updated settings.json schema**:

```json
{
  "providers": [
    {
      "id": "openai-primary",
      "name": "OpenAI Primary",
      "type": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "circuitBreaker": {
        "enabled": true,
        "failureThreshold": 5,
        "successThreshold": 3,
        "timeoutMs": 30000
      },
      "pricing": {
        "inputPricePer1k": 0.005,
        "outputPricePer1k": 0.015
      }
    },
    {
      "id": "groq-backup",
      "name": "Groq Backup",
      "type": "openai-compatible",
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "llama-3.1-70b",
    }
  ],
  "defaultProvider": "openai-primary",
  "failover": {
    "enabled": true,
    "threshold": 3,
    "order": ["openai-primary", "groq-backup"]
  },
  "costTracking": {
    "enabled": true,
    "currency": "USD"
  }
}
```

---

## Testing Strategy

### Circuit Breaker Tests
- Trip after N failures
- Open circuit rejects requests
- Half-open allows test calls
- Close after N successes
- Timeout before retry

### Failover Tests
- Failover after threshold errors
- Provider switch on failure
- Retry with new provider
- Event emission
- Concurrent failover prevention

### Cost Tracking Tests
- Cost calculation accuracy
- Token counting
- Daily aggregation
- Export functionality
- Pricing override

### Resilience Tests
- cascading failure prevention
- Recovery after outage
- Metrics accuracy under load

---

## Success Metrics

| Feature | Target | Measurement |
|---------|--------|-------------|
| Circuit Breaker | <50ms overhead | Benchmark |
| Failover Time | <2s | Timer |
| Cost Accuracy | ±0.001 USD | Test data |
| State Transitions | Logged | Event count |
| Recovery Time | <30s | Timer |

---

## Files to Create

1. `CircuitBreaker.ts` - Core circuit breaker logic
2. `CostTracker.ts` - Cost tracking implementation
3. `CircuitBreaker.test.ts` - Unit tests
4. `CostTracker.test.ts` - Unit tests
5. `integration.test.ts` - E2E tests
6. Update `ProviderService.ts` - Add failover + cost tracking
7. Update `BaseProviderAdapter.ts` - Add circuit breaker integration

Total: ~4 new files, ~600 lines of code, 2 file updates

---

## Dependencies

- Existing: `zod`, `EventEmitter`, `debugLogger`
- None new required

Ready to implement? Start with Circuit Breaker (Task 3.1)?