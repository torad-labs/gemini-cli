# Provider-as-a-Service Layer Implementation Plan

## Current State Analysis

### Existing Architecture
1. **`ContentGenerator`** - Interface in `packages/core/src/core/contentGenerator.ts`
   - Defines core methods: `generateContent`, `generateContentStream`, `countTokens`, `embedContent`
   - Has optional metadata: `userTier`, `userTierName`, `paidTier`
   - Optional methods: `listModels`, `fetchModelMetadata`

2. **Provider Registry** - Basic factory in `packages/core/src/providers/registry.ts`
   - Currently: `ProviderRegistry` class with `create(config)` method
   - Returns `ContentGenerator | undefined`
   - Only handles `google-genai` and `openai-compatible` types
   - Limited to one-off instantiation

3. **`createContentGenerator`** function
   - Complex 250+ line factory function
   - Switches between different providers based on auth type
   - Directly instantiates `ProviderRegistry`, wraps in `LoggingContentGenerator`
   - Hardcoded provider logic

## Problems with Current Architecture

1. **No Service Layer** - Code directly depends on `ContentGenerator` interface
2. **Tight Coupling** - Client code calls `createContentGenerator` which calls `ProviderRegistry`
3. **No State Management** - Can't hot-swap providers, no runtime provider switching
4. **Limited Abstractions** - No unified way to handle provider capabilities, health checks, pooling
5. **DI Unfriendly** - Hard to mock/test without complex setup

## Target Architecture: Provider-as-a-Service

### Core Components

```
ProviderService (Facade)
    └── IProviderAdapter (Interface)
        ├── BaseProviderAdapter (Abstract Class)
        │   ├── GoogleGenAIProviderAdapter
        │   ├── OpenAICompatibleProviderAdapter
        │   └── [Future: HuggingFaceAdapter, ReplicateAdapter, etc.]
        └── ProviderPool (for connection management)
    
ProviderManager (Lifecycle & Registry)
    ├── ProviderRegistry (Improved)
    ├── CapabilityDiscovery
    └── HealthMonitoring

ProviderConfigService (Configuration)
    ├── ConfigValidator
    ├── ConfigMerger (env + settings + runtime)
    └── ConfigHotReload
```

## Detailed Implementation Plan

### Phase 1: Core Service Layer (2-3 sprints)

#### Task 1.1: Define IProviderService Interface
**File:** `packages/core/src/providers/IProviderService.ts`

```typescript
export interface IProviderService {
  // Core operations
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse>;
  
  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;
  
  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;
  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;
  
  // Provider management
  getCurrentProvider(): IProviderAdapter;
  switchProvider(providerId: string): Promise<void>;
  listAvailableProviders(): ProviderInfo[];
  
  // Health & capabilities
  getProviderHealth(providerId: string): ProviderHealthStatus;
  probeCapabilities(providerId: string): Promise<ModelCapabilities>;
  
  // Events
  onProviderChange(handler: ProviderChangeHandler): Unsubscribe;
}

export interface ProviderInfo {
  id: string;
  name: string;
  type: ProviderType;
  isActive: boolean;
  capabilities: ModelCapabilities;
  health: ProviderHealthStatus;
}

export type ProviderHealthStatus = 
  | { status: 'healthy'; latencyMs: number }
  | { status: 'degraded'; latencyMs: number; reason: string }
  | { status: 'unavailable'; reason: string };

export type ProviderChangeHandler = (event: {
  from: IProviderAdapter | null;
  to: IProviderAdapter;
}) => void;
```

#### Task 1.2: Create IProviderAdapter Interface
**File:** `packages/core/src/providers/IProviderAdapter.ts`

```typescript
export interface IProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;
  readonly config: ProviderConfig;
  
  // Lifecycle
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  
  // Core operations (from ContentGenerator + metadata)
  generateContent(...): Promise<GenerateContentResponse>;
  generateContentStream(...): Promise<AsyncGenerator<GenerateContentResponse>>;
  countTokens(...): Promise<CountTokensResponse>;
  embedContent(...): Promise<EmbedContentResponse>;
  
  // Provider-specific features
  listModels(): Promise<ModelMetadata[]>;
  getModelMetadata(modelId: string): ModelMetadata | undefined;
  
  // Health & metrics
  health: ProviderHealthStatus;
  getMetrics(): ProviderMetrics;
  
  // Events
  onHealthChange(handler: HealthChangeHandler): Unsubscribe;
}

export interface ModelMetadata {
  id: string;
  name: string;
  contextWindow: number;
  capabilities: ModelCapabilities;
  pricing?: { input: number; output: number };
}

export interface ProviderMetrics {
  totalRequests: number;
  totalTokens: number;
  averageLatency: number;
  errorRate: number;
  lastUsed: Date;
}
```

#### Task 1.3: Implement BaseProviderAdapter
**File:** `packages/core/src/providers/BaseProviderAdapter.ts`

Abstract class implementing:
- Common retry logic (from current `OpenAICompatibleContentGenerator`)
- Timeout handling
- Error context enhancement
- Metrics collection
- Event emission
- Health check base implementation

Key methods:
- `protected abstract doGenerateContent()` - override by subclasses
- `protected abstract doListModels()` - override by subclasses  
- `protected callWithRetry<T>()` - common retry logic
- `protected updateHealth()` - health state management

#### Task 1.4: Refactor Existing Provider to Adapters

**OpenAICompatibleProviderAdapter**
- Extend `BaseProviderAdapter`
- Wrap existing `OpenAICompatibleContentGenerator`
- Add model metadata caching from `/models` endpoint
- Implement health checks via `/health` or lightweight request

**GoogleGenAIProviderAdapter**
- Extend `BaseProviderAdapter`
- Wrap `GoogleGenAI` client
- Handle Gemini-specific auth and routing

#### Task 1.5: Implement ProviderService
**File:** `packages/core/src/providers/ProviderService.ts`

Responsibilities:
- Hold reference to current active provider
- Maintain registry of available providers
- Handle provider switching with cleanup
- Emit events on provider changes
- Route all calls to active provider
- Handle fallback logic

```typescript
export class ProviderService implements IProviderService {
  private currentProvider: IProviderAdapter | null = null;
  private providers = new Map<string, IProviderAdapter>();
  private eventBus = new EventEmitter();
  
  async initialize(): Promise<void> {
    // Load configured providers from settings
    // Initialize default provider
  }
  
  async switchProvider(providerId: string): Promise<void> {
    const newProvider = this.providers.get(providerId);
    if (!newProvider) throw new Error(`Provider ${providerId} not found`);
    
    const oldProvider = this.currentProvider;
    await oldProvider?.dispose();
    await newProvider.initialize();
    
    this.currentProvider = newProvider;
    this.eventBus.emit('providerChange', { from: oldProvider, to: newProvider });
  }
  
  // Implement IProviderService methods...
}
```

### Phase 2: Configuration & Hot Reload (1-2 sprints)

#### Task 2.1: ProviderConfigService
**File:** `packages/core/src/providers/ProviderConfigService.ts`

- Merge environment variables, settings.json, runtime overrides
- Watch file changes for hot reload
- Validate config with Zod schemas
- Support provider templates/presets

#### Task 2.2: Hot Reload Implementation
- File watcher on settings.json
- Graceful provider switch without session loss
- Validation before switching (test new provider first)

### Phase 3: Advanced Features (2-3 sprints)

#### Task 3.1: Provider Pool & Connection Management
- Connection pooling for providers with connection limits
- Circuit breaker pattern for failing providers
- Load balancing across multiple providers

#### Task 3.2: Capability Discovery
- Auto-detect model capabilities on startup
- Cache capability results
- Expose UI for manual capability refresh

#### Task 3.3: Health Monitoring  
- Periodic health checks (ping /models endpoint)
- Automatic failover to healthy provider
- Degraded mode when primary fails

#### Task 3.4: Telemetry Integration
- OpenTelemetry traces for provider operations
- Metrics export (latency, token usage, errors)
- Cost tracking per provider

### Phase 4: CLI Integration (1 sprint)

#### Task 4.1: CLI Commands
- `/provider list` - List available providers
- `/provider switch <id>` - Switch active provider
- `/provider status` - Show provider health
- `/provider add` - Interactive provider setup wizard

#### Task 4.2: UI Components
- Provider status indicator in footer
- Provider switch dialog
- Health status visualization

#### Task 4.3: Update GeminiClient
- Inject `IProviderService` instead of `ContentGenerator`
- Remove direct dependency on `createContentGenerator`
- React to provider change events

## Migration Strategy

### Step 1: Create New Interfaces (Non-breaking)
- Add new files without touching existing code
- Ensure TypeScript compatibility

### Step 2: Implement Adapters Side-by-Side
- Keep existing `OpenAICompatibleContentGenerator`
- Create new `OpenAICompatibleProviderAdapter`
- Run both in parallel with feature flags

### Step 3: Gradual Migration
- Update `createContentGenerator` to optionally use new service
- Add config flag: `useProviderService: true`
- Test thoroughly

### Step 4: Full Cutover
- Default to new service
- Deprecate old pattern
- Remove after 2-3 releases

## Testing Strategy

1. **Unit Tests**
   - Mock adapters
   - Service layer logic
   - Config validation

2. **Integration Tests**
   - Real provider connections in test environment
   - Provider switching scenarios
   - Fallback behavior

3. **E2E Tests**
   - Full CLI flow with provider service
   - Hot reload scenarios
   - Error recovery

## Benefits After Implementation

1. **Clean Architecture** - Clear separation of concerns
2. **Testability** - Easy to mock service layer
3. **Extensibility** - Add new providers as adapter classes
4. **Dynamic Switching** - Change providers without restart
5. **Observability** - Health checks, metrics, tracing built-in
6. **Resilience** - Automatic failover, circuit breakers
7. **Developer Experience** - Consistent API, clear error messages

## Priority Order

1. **Week 1-2**: Tasks 1.1-1.3 (Interfaces + BaseAdapter)
2. **Week 3-4**: Task 1.4 (Refactor existing providers)
3. **Week 5**: Task 1.5 (ProviderService) 
4. **Week 6**: Task 2.1 (ConfigService)
5. **Week 7**: Task 4.1-4.3 (CLI Integration)
6. **Week 8+**: Phase 3 advanced features

Total: ~8 weeks for full implementation

## Success Metrics

- All existing tests pass
- Provider switching works without session loss
- Hot reload doesn't crash CLI
- Response latency within 10% of current
- Zero regressions in core functionality
- New providers can be added with <100 lines of code