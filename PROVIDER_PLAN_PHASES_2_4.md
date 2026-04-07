# Provider-as-a-Service: Phases 2-4 Implementation Plan

## Phase 2: Configuration Service & Hot Reload (2-3 weeks)

### Goal
Enable dynamic provider configuration via files, environment variables, and runtime changes with hot reload capabilities.

### Task 2.1: ProviderConfigService
**File:** `packages/core/src/providers/ProviderConfigService.ts`

```typescript
export interface ProviderConfigService {
  // Load configuration from all sources
  loadConfig(): Promise<ProviderServiceConfig>;
  
  // Watch for changes and auto-reload
  startWatching(): void;
  stopWatching(): void;
  
  // Validate configuration
  validateConfig(config: unknown): ValidationResult;
  
  // Get effective config (merged from all sources)
  getEffectiveConfig(): ProviderServiceConfig;
  
  // Update runtime config (temporary, not persisted)
  updateRuntimeConfig(updates: Partial<ProviderServiceConfig>): void;
  
  // Events
  onConfigChange(handler: ConfigChangeHandler): Unsubscribe;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}
```

**Configuration Sources (priority order - highest to lowest):**
1. Runtime overrides (set via API/UI)
2. Environment variables (`PROVIDER_*`, `OPENAI_*`)
3. `settings.json` providers section
4. Default presets
5. Built-in defaults

**Implementation Details:**

```typescript
export class ProviderConfigServiceImpl implements ProviderConfigService {
  private _fileWatcher?: FileWatcher;
  private _runtimeConfig: Partial<ProviderServiceConfig> = {};
  private _cachedConfig?: ProviderServiceConfig;
  private _eventBus = new EventEmitter();
  
  constructor(
    private _settingsPath: string,
    private _env: NodeJS.ProcessEnv = process.env
  ) {}
  
  async loadConfig(): Promise<ProviderServiceConfig> {
    // Load from all sources
    const fromDefaults = this._loadDefaults();
    const fromPresets = this._loadPresets();
    const fromSettings = await this._loadFromSettings();
    const fromEnv = this._loadFromEnv();
    const fromRuntime = this._runtimeConfig;
    
    // Deep merge with priority
    this._cachedConfig = deepMerge(
      fromDefaults,
      fromPresets,
      fromSettings,
      fromEnv,
      fromRuntime
    );
    
    // Validate
    const validation = this.validateConfig(this._cachedConfig);
    if (!validation.valid) {
      throw new ConfigValidationError(validation.errors);
    }
    
    return this._cachedConfig;
  }
  
  startWatching(): void {
    // Watch settings.json for changes
    this._fileWatcher = watchFile(this._settingsPath, async () => {
      const oldConfig = this._cachedConfig;
      const newConfig = await this.loadConfig();
      
      if (!deepEqual(oldConfig, newConfig)) {
        this._eventBus.emit('configChange', { old: oldConfig, new: newConfig });
        
        // Auto-apply if hot reload enabled
        if (newConfig.hotReload !== false) {
          await this._applyConfigChanges(oldConfig, newConfig);
        }
      }
    });
  }
  
  private async _applyConfigChanges(
    oldConfig: ProviderServiceConfig,
    newConfig: ProviderServiceConfig
  ): Promise<void> {
    // Added providers
    for (const [id, provider] of Object.entries(newConfig.providers)) {
      if (!oldConfig.providers[id]) {
        await this._addProvider(provider);
      }
    }
    
    // Removed providers
    for (const id of Object.keys(oldConfig.providers)) {
      if (!newConfig.providers[id]) {
        await this._removeProvider(id);
      }
    }
    
    // Modified providers
    for (const [id, newProvider] of Object.entries(newConfig.providers)) {
      const oldProvider = oldConfig.providers[id];
      if (oldProvider && !deepEqual(oldProvider, newProvider)) {
        await this._updateProvider(id, newProvider);
      }
    }
    
    // Switch default if changed
    if (oldConfig.defaultProviderId !== newConfig.defaultProviderId) {
      await this._providerService.switchProvider(newConfig.defaultProviderId);
    }
  }
}
```

**Zod Schema for Validation:**

```typescript
const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['openai-compatible', 'google-genai', 'custom']),
  apiKey: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1),
  timeout: z.number().min(1000).max(300000).optional(),
  firstTokenTimeout: z.number().min(100).max(60000).optional(),
  retryAttempts: z.number().min(0).max(10).optional(),
  retryBackoffMs: z.number().min(100).max(60000).optional(),
  healthCheck: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().min(5000).max(300000).default(60000),
    timeoutMs: z.number().min(1000).max(60000).default(10000),
  }).optional(),
  circuitBreaker: z.object({
    enabled: z.boolean().default(true),
    failureThreshold: z.number().min(1).max(20).default(5),
    recoveryTimeoutMs: z.number().min(1000).max(600000).default(30000),
  }).optional(),
});

const ProviderServiceConfigSchema = z.object({
  version: z.literal('1.0'),
  defaultProviderId: z.string().optional(),
  hotReload: z.boolean().default(true),
  providers: z.record(ProviderConfigSchema),
  global: z.object({
    enableHealthMonitoring: z.boolean().default(true),
    healthCheckIntervalMs: z.number().min(5000).max(300000).default(60000),
    autoFailover: z.boolean().default(false),
  }).optional(),
});
```

### Task 2.2: Settings.json Integration

**Update `settingsSchema.ts`:**

```typescript
providers: {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      type: { 
        type: 'string', 
        enum: ['openai-compatible', 'google-genai', 'ollama', 'nvidia-nim', 'deepinfra', 'groq', 'together', 'fireworks', 'xai'] 
      },
      apiKey: { type: 'string' },
      // Supports $ENV_VAR syntax
      apiKeyEnv: { type: 'string' },
      baseUrl: { type: 'string' },
      model: { type: 'string' },
      timeout: { type: 'number' },
      retryAttempts: { type: 'number' },
    },
    required: ['id', 'type', 'model'],
  },
},
defaultProvider: { type: 'string' },
providerHotReload: { type: 'boolean', default: true },
```

### Task 2.3: Hot Reload UI

**File:** `packages/cli/src/ui/components/ProviderConfigDialog.tsx`

Features:
- Show config diff when file changes
- Confirm/cancel reload
- Visual indicator for unsaved changes
- "Reload now" button

### Task 2.4: Environment Variable Mapping

Create mapping table:

| Setting | Env Var | Example |
|---------|---------|---------|
| Default Provider | `GEMINI_DEFAULT_PROVIDER` | `ollama` |
| Provider API Key | `GEMINI_PROVIDER_API_KEY` | `sk-...` |
| Provider Base URL | `GEMINI_PROVIDER_BASE_URL` | `http://localhost:11434/v1` |
| Provider Model | `GEMINI_PROVIDER_MODEL` | `llama3.2` |
| Provider Timeout | `GEMINI_PROVIDER_TIMEOUT` | `60000` |

## Phase 3: Advanced Features (3-4 weeks)

### Task 3.1: Circuit Breaker Pattern

**File:** `packages/core/src/providers/CircuitBreaker.ts`

```typescript
export interface CircuitBreakerConfig {
  failureThreshold: number;      // Trip after N failures
  successThreshold: number;      // Close after N successes
  timeoutMs: number;             // Wait before half-open
  halfOpenMaxCalls: number;      // Test calls in half-open
}

export enum CircuitBreakerState {
  CLOSED = 'closed',       // Normal operation
  OPEN = 'open',           // Failing, reject requests
  HALF_OPEN = 'half-open', // Testing if recovered
}

export class CircuitBreaker {
  private _state = CircuitBreakerState.CLOSED;
  private _failures = 0;
  private _successes = 0;
  private _lastFailureTime?: Date;
  private _nextAttempt = 0;
  
  constructor(private _config: CircuitBreakerConfig) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === CircuitBreakerState.OPEN) {
      if (Date.now() < this._nextAttempt) {
        throw new CircuitBreakerOpenError();
      }
      // Move to half-open
      this._state = CircuitBreakerState.HALF_OPEN;
    }
    
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }
  
  getState(): CircuitBreakerState {
    return this._state;
  }
}
```

Integrate into BaseProviderAdapter:

```typescript
export abstract class BaseProviderAdapter implements IProviderAdapter {
  private _circuitBreaker: CircuitBreaker;
  
  protected async _withRetryAndMetrics<T>(
    operation: string,
    requestId: string,
    fn: () => Promise<T>
  ): Promise<T> {
    // Wrap with circuit breaker
    return this._circuitBreaker.execute(() => 
      this._executeWithRetry(operation, requestId, fn)
    );
  }
}
```

### Task 3.2: Provider Pool & Connection Management

**File:** `packages/core/src/providers/ProviderPool.ts`

For providers with connection limits (e.g., some enterprise APIs):

```typescript
export interface PoolConfig {
  maxConnections: number;
  minConnections: number;
  acquireTimeoutMs: number;
  idleTimeoutMs: number;
  connectionLifetimeMs: number;
}

export class ProviderPool {
  private _available: Connection[] = [];
  private _inUse: Set<Connection> = new Set();
  private _waiting: Array<Resolve<Connection>> = [];
  
  async acquire(): Promise<Connection> {
    if (this._available.length > 0) {
      const conn = this._available.pop()!;
      this._inUse.add(conn);
      return conn;
    }
    
    if (this._inUse.size < this._config.maxConnections) {
      const conn = await this._createConnection();
      this._inUse.add(conn);
      return conn;
    }
    
    // Wait for connection
    return new Promise((resolve) => {
      this._waiting.push(resolve);
    });
  }
  
  release(conn: Connection): void {
    this._inUse.delete(conn);
    
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()!;
      this._inUse.add(conn);
      next(conn);
    } else {
      this._available.push(conn);
    }
  }
}
```

### Task 3.3: Load Balancing

**File:** `packages/core/src/providers/LoadBalancer.ts`

For multiple providers of same type:

```typescript
export type LoadBalancingStrategy = 
  | 'round-robin'
  | 'least-connections'
  | 'weighted-response-time'
  | 'random';

export class LoadBalancer {
  private _providers: WeightedProvider[] = [];
  private _currentIndex = 0;
  
  constructor(private _strategy: LoadBalancingStrategy) {}
  
  select(): IProviderAdapter {
    switch (this._strategy) {
      case 'round-robin':
        return this._roundRobin();
      case 'least-connections':
        return this._leastConnections();
      case 'weighted-response-time':
        return this._weightedResponseTime();
      default:
        return this._random();
    }
  }
  
  private _roundRobin(): IProviderAdapter {
    const provider = this._providers[this._currentIndex];
    this._currentIndex = (this._currentIndex + 1) % this._providers.length;
    return provider.adapter;
  }
  
  private _weightedResponseTime(): IProviderAdapter {
    // Select provider with lowest average latency
    // Weight by inverse of latency
    const weights = this._providers.map(p => {
      const metrics = p.adapter.getMetrics();
      return 1 / Math.max(metrics.averageLatency, 1);
    });
    
    return this._weightedRandom(weights);
  }
}
```

### Task 3.4: Automatic Failover

Enhance ProviderService with automatic failover:

```typescript
export class ProviderService implements IProviderService {
  private _autoFailover: boolean;
  private _failoverThreshold: number;
  private _consecutiveErrors = 0;
  
  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse> {
    try {
      const result = await this._currentProvider!.generateContent(
        request, userPromptId, role
      );
      this._consecutiveErrors = 0;
      return result;
    } catch (error) {
      this._consecutiveErrors++;
      
      if (this._autoFailover && 
          this._consecutiveErrors >= this._failoverThreshold) {
        const failed = this._currentProvider!;
        await this.autoFailover();
        
        // Retry with new provider
        return this._currentProvider!.generateContent(
          request, userPromptId, role
        );
      }
      throw error;
    }
  }
  
  async autoFailover(): Promise<boolean> {
    const current = this._currentProvider;
    const healthyProviders = Array.from(this._providers.values())
      .filter(p => p.health.status !== 'unavailable');
    
    if (healthyProviders.length === 0) {
      throw new Error('No healthy providers available for failover');
    }
    
    // Select best based on health + metrics
    const candidates = healthyProviders
      .filter(p => p.id !== current?.id)
      .map(p => ({
        adapter: p,
        score: this._calculateFailoverScore(p),
      }))
      .sort((a, b) => b.score - a.score);
    
    if (candidates.length === 0) {
      return false;
    }
    
    await this.switchProvider(candidates[0]!.adapter.id);
    this._consecutiveErrors = 0;
    return true;
  }
}
```

### Task 3.5: Cost Tracking

**File:** `packages/core/src/providers/CostTracker.ts`

```typescript
export interface CostRecord {
  timestamp: Date;
  providerId: string;
  modelId: string;
  operation: 'generate' | 'embed' | 'count';
  inputTokens: number;
  outputTokens?: number;
  cost: number; // In USD
}

export class CostTracker {
  private _records: CostRecord[] = [];
  
  track(record: Omit<CostRecord, 'timestamp'>): void {
    this._records.push({ ...record, timestamp: new Date() });
  }
  
  getTotalCost(since?: Date): number {
    return this._records
      .filter(r => !since || r.timestamp >= since)
      .reduce((sum, r) => sum + r.cost, 0);
  }
  
  getCostByProvider(): Map<string, number> {
    const costs = new Map<string, number>();
    for (const record of this._records) {
      const current = costs.get(record.providerId) ?? 0;
      costs.set(record.providerId, current + record.cost);
    }
    return costs;
  }
  
  export(): CostRecord[] {
    return [...this._records];
  }
}
```

## Phase 4: CLI Integration (2 weeks)

### Task 4.1: Provider CLI Commands

**File:** `packages/cli/src/commands/ProviderCommands.ts`

```typescript
export class ProviderCommands {
  constructor(private _service: IProviderService) {}
  
  @SlashCommand({
    name: '/provider',
    description: 'Provider management commands',
  })
  async handle(): Promise<void> {
    // Show help
  }
  
  @SubCommand('list')
  async list(): Promise<void> {
    const providers = this._service.listAvailableProviders();
    
    const table = new Table({
      head: ['ID', 'Name', 'Status', 'Health', 'Active'],
      colWidths: [20, 20, 12, 12, 10],
    });
    
    for (const provider of providers) {
      table.push([
        provider.id,
        provider.name,
        provider.capabilities.supportsStreaming ? 'online' : 'offline',
        provider.health.status,
        provider.isActive ? '✓' : '',
      ]);
    }
    
    console.log(table.toString());
  }
  
  @SubCommand('switch')
  async switch(id: string): Promise<void> {
    await this._service.switchProvider(id);
    console.log(`✓ Switched to provider: ${id}`);
  }
  
  @SubCommand('add')
  async add(): Promise<void> {
    const config = await this._promptProviderConfig();
    const adapter = await this._createAdapter(config);
    this._service.registerProvider(adapter);
    console.log(`✓ Added provider: ${config.id}`);
  }
  
  @SubCommand('remove')
  async remove(id: string): Promise<void> {
    await this._service.unregisterProvider(id);
    console.log(`✓ Removed provider: ${id}`);
  }
  
  @SubCommand('status')
  async status(id?: string): Promise<void> {
    const providers = id 
      ? [this._service.getProviderInfo(id)].filter(Boolean)
      : this._service.listAvailableProviders();
    
    for (const provider of providers) {
      if (!provider) continue;
      
      const metrics = this._service.getCurrentProvider()?.getMetrics();
      
      console.log(`
${provider.name} (${provider.id})`);
      console.log(`  Type: ${provider.type}`);
      console.log(`  Health: ${provider.health.status}`);
      console.log(`  Active: ${provider.isActive ? 'Yes' : 'No'}`);
      
      if (metrics) {
        console.log(`  Requests: ${metrics.totalRequests}`);
        console.log(`  Avg Latency: ${metrics.averageLatency.toFixed(0)}ms`);
        console.log(`  Error Rate: ${(metrics.errorRate * 100).toFixed(1)}%`);
      }
      
      console.log(`  Capabilities:`);
      console.log(`    - Tool calling: ${provider.capabilities.supportsToolCalling ? 'Yes' : 'No'}`);
      console.log(`    - Vision: ${provider.capabilities.supportsVision ? 'Yes' : 'No'}`);
      console.log(`    - Streaming: ${provider.capabilities.supportsStreaming ? 'Yes' : 'No'}`);
    }
  }
  
  @SubCommand('metrics')
  async metrics(): Promise<void> {
    const summary = this._service.getMetricsSummary();
    
    console.log('
Provider Metrics Summary');
    console.log(`  Total Providers: ${summary.totalProviders}`);
    console.log(`  Healthy: ${summary.healthyProviders}`);
    console.log(`  Total Requests: ${summary.totalRequests}`);
    console.log(`  Avg Error Rate: ${(summary.averageErrorRate * 100).toFixed(2)}%`);
    
    const costs = this._costTracker.getCostByProvider();
    if (costs.size > 0) {
      console.log('
  Costs by Provider:');
      for (const [id, cost] of costs) {
        console.log(`    ${id}: $${cost.toFixed(4)}`);
      }
    }
  }
}
```

### Task 4.2: UI Components

**ProviderStatusIndicator.tsx:**

```typescript
export function ProviderStatusIndicator(): React.JSX.Element {
  const service = useProviderService();
  const current = service.getCurrentProvider();
  const health = current?.health;
  
  const statusColor = {
    healthy: 'green',
    degraded: 'yellow', 
    unavailable: 'red',
    unknown: 'gray',
  }[health?.status ?? 'unknown'];
  
  return (
    <Box>
      <Text color={statusColor}>●</Text>
      <Text> {current?.name ?? 'No Provider'}</Text>
      {health?.status === 'degraded' && (
        <Text color="yellow"> ({health.reason})</Text>
      )}
    </Box>
  );
}
```

**ProviderSwitchDialog.tsx:**

```typescript
export function ProviderSwitchDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const service = useProviderService();
  const providers = service.listAvailableProviders();
  const [selected, setSelected] = useState<string>('');
  
  const handleSwitch = async () => {
    if (selected) {
      await service.switchProvider(selected);
      onClose();
    }
  };
  
  return (
    <Box>
      <Text bold>Select Provider:</Text>
      {providers.map(provider => (
        <RadioButton
          key={provider.id}
          checked={selected === provider.id}
          onSelect={() => setSelected(provider.id)}
        >
          {provider.name} ({provider.health.status})
        </RadioButton>
      ))}
      <Box marginTop={1}>
        <Button onPress={handleSwitch}>Switch</Button>
        <Button onPress={onClose}>Cancel</Button>
      </Box>
    </Box>
  );
}
```

### Task 4.3: Integration with GeminiClient

**Update `packages/core/src/core/client.ts`:**

```typescript
export class GeminiClient {
  constructor(
    private _config: Config,
    private _providerService: IProviderService, // Injected instead of created
  ) {}
  
  async sendMessageStream(
    // ... existing params
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    // Use provider service instead of direct ContentGenerator
    return this._providerService.generateContentStream(
      request,
      promptId,
      this._currentRole,
    );
  }
}
```

**Factory function:**

```typescript
// packages/core/src/core/clientFactory.ts
export async function createGeminiClient(
  config: Config,
): Promise<GeminiClient> {
  // Create and initialize provider service
  const providerService = new ProviderService({
    defaultProviderId: config.getDefaultProviderId(),
    enableHealthMonitoring: true,
  });
  
  // Load providers from config
  const providerConfigs = await loadProviderConfigs(config);
  for (const providerConfig of providerConfigs) {
    const adapter = createProviderAdapter(providerConfig);
    providerService.registerProvider(adapter);
  }
  
  await providerService.initialize();
  
  return new GeminiClient(config, providerService);
}
```

## Implementation Order

### Phase 2 Priority:
1. ✅ Phase 1 complete (service layer)
2. Week 1: Config validation service with Zod schemas
3. Week 2: Settings.json integration + file watching
4. Week 3: Hot reload UI + testing

### Phase 3 Priority:
5. Week 4-5: Circuit breaker pattern
6. Week 6: Connection pooling (if needed for specific providers)
7. Week 7-8: Auto-failover + cost tracking

### Phase 4 Priority:
8. Week 9: CLI commands
9. Week 10: UI components + final integration

Total: ~10 weeks for full implementation with proper testing.

## Success Metrics Phase 2-4

- ✅ Configuration changes apply without restart (< 1s)
- ✅ Provider switch completes without session loss
- ✅ Auto-failover triggers within 3 consecutive errors
- ✅ Circuit breaker prevents cascade failures
- ✅ Cost tracking accurate to 4 decimal places
- ✅ UI shows real-time provider health
- ✅ All commands work: `/provider list`, `/provider switch`, `/provider status`

## Files to Create (Estimated)

Phase 2: ~5 new files
Phase 3: ~6 new files  
Phase 4: ~4 new files
Total: ~15 new files, ~2000 lines of code

## Testing Strategy

- Unit tests for each new service
- Integration tests for provider switching
- E2E tests for hot reload
- Load tests for circuit breaker
