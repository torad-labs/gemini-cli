# Gemini CLI Fork — Multi-Provider Agent Platform

## Goal

Transform gemini-cli into a provider-agnostic agent platform that can run any
OpenAI-compatible model (starting with NVIDIA Nemotron via NIM), connect to
Discord, and serve as the runtime for torad-toolkit agents until torad is ready
to be the super-agent.

## Architecture Overview

```
Discord / HTTP API / Telegram / CLI
        │
   Transport Layer (thin bridges, one per channel type)
        │
   Agent Router (SOUL.md-based identity, multi-agent bindings, rate limiting)
        │
   SDK Layer (@google/gemini-cli-sdk — already exists, clean API)
        │
   Core Agent Loop (GeminiClient → Turn → GeminiChat → tool scheduling → MCP)
        │
   ContentGenerator Interface  ← THIS IS THE SEAM (4 methods)
        │
   ProviderRegistry (routing + fallback chains)
        │
   ┌────────────┬──────────────┬─────────────┐
   Google GenAI  OpenAI-compat  Anthropic
   (Gemini)     (NIM, Grok,    (Claude)
                 Ollama, etc)
```

---

## The Seam: ContentGenerator Interface

**File:** `packages/core/src/core/contentGenerator.ts` (lines 33-55)

```typescript
interface ContentGenerator {
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
  userTier?: UserTierId;
  userTierName?: string;
  paidTier?: GeminiUserTier;
}
```

**Substitution point:** `contentGenerator.ts` line 271

```typescript
// Current:
return new LoggingContentGenerator(googleGenAI.models, gcConfig);
// New:
return new LoggingContentGenerator(providerRegistry.create(config), gcConfig);
```

**Everything above this interface is untouched:**

- GeminiClient (client.ts, 1267 lines) — orchestrates turns and tool scheduling
- GeminiChat (geminiChat.ts, 1076 lines) — builds requests, handles retries
- Turn (turn.ts, 447 lines) — parses responses, extracts tool calls, yields
  events
- LoggingContentGenerator — wraps ANY ContentGenerator with telemetry
- SDK layer — transparent, consumes events from Turn
- MCP, tool registry, session persistence — all unchanged

---

## Phase 1: OpenAI-Compatible ContentGenerator + Observability + Resilience

**Delivers:** Any OpenAI-compatible model works. MLflow tracing. Graceful error
handling.

### The Problem

The entire stack uses `@google/genai` types. Turn.ts reads
`resp.candidates[0].content.parts[]` and `resp.functionCalls`. An OpenAI
response has `choices[0].message.content` and `choices[0].message.tool_calls[]`.
These are incompatible.

### The Solution: Adapter Pattern

Build an `OpenAIContentGenerator` that:

1. **Receives** `GenerateContentParameters` (Gemini format)
2. **Converts** to OpenAI `ChatCompletionCreateParams`
3. **Calls** OpenAI-compatible API (NIM, Grok, Ollama, etc.)
4. **Converts** OpenAI `ChatCompletion` response back to
   `GenerateContentResponse`
5. **Validates** the constructed response before yielding (assertion layer)

The rest of the stack never knows the difference.

### Type Mapping Reference

#### Request Conversion (Gemini → OpenAI)

| Gemini (input)                                           | OpenAI (output)                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `config.systemInstruction` (string)                      | `messages[0] = { role: "system", content: string }`                             |
| `contents[].role: "user"`                                | `messages[].role: "user"`                                                       |
| `contents[].role: "model"`                               | `messages[].role: "assistant"`                                                  |
| `contents[].parts[].text`                                | `messages[].content: string`                                                    |
| `contents[].parts[].functionCall { name, args }`         | `messages[].tool_calls[{ id, type:"function", function:{ name, arguments } }]`  |
| `contents[].parts[].functionResponse { name, response }` | `messages[] = { role:"tool", tool_call_id, content: JSON.stringify(response) }` |
| `config.tools[].functionDeclarations[]`                  | `tools[].type:"function"` with `function:{ name, description, parameters }`     |
| `model: "nvidia/nemotron-..."`                           | `model: "nvidia/nemotron-..."` (passthrough)                                    |

#### Response Conversion (OpenAI → Gemini)

| OpenAI (received)                                                   | Gemini (constructed)                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `choices[0].delta.content`                                          | `candidates[0].content.parts[{ text }]`                           |
| `choices[0].delta.tool_calls[{ id, function:{ name, arguments } }]` | `functionCalls[{ id, name, args: JSON.parse(arguments) }]`        |
| `choices[0].finish_reason: "stop"`                                  | `candidates[0].finishReason: "STOP"`                              |
| `choices[0].finish_reason: "tool_calls"`                            | `candidates[0].finishReason: "STOP"` (Gemini doesn't distinguish) |
| `choices[0].finish_reason: "length"`                                | `candidates[0].finishReason: "MAX_TOKENS"`                        |
| `usage.prompt_tokens`                                               | `usageMetadata.promptTokenCount`                                  |
| `usage.completion_tokens`                                           | `usageMetadata.candidatesTokenCount`                              |
| `id`                                                                | `responseId`                                                      |

### Critical Fields Turn.ts Reads (lines 308-359)

These MUST be present in our constructed `GenerateContentResponse`:

```typescript
// Line 308 — parts extraction
resp.candidates?.[0]?.content?.parts ?? [];

// Line 310-315 — thought detection
part.thought; // boolean — OpenAI doesn't have this, always false

// Line 316 — text content
part.text; // string

// Line 326 — function calls (DIRECT property on response, not nested)
resp.functionCalls ?? [];

// Line 339 — finish reason
resp.candidates?.[0]?.finishReason;

// Line 344 — usage metadata
resp.usageMetadata;

// Line 350 — response ID (tracing)
resp.responseId;
```

### Implementation Plan

#### Files to Create

1. **`packages/core/src/providers/openai-compatible.ts`** (~400 lines)
   - `OpenAICompatibleContentGenerator implements ContentGenerator`
   - Constructor: `(config: OpenAIProviderConfig)`
   - `generateContentStream()`:
     - Convert Gemini request → OpenAI request
     - Call `/chat/completions` with `stream: true`
     - Parse SSE chunks via streaming tool call state machine
     - Validate constructed `GenerateContentResponse` before yielding
     - Handle streaming tool calls (buffer incrementally until complete)
   - `generateContent()`: Same but non-streaming
   - `countTokens()`: Call model's token counting endpoint or estimate locally
   - `embedContent()`: Call `/embeddings` endpoint
   - **Retry with exponential backoff** for 429/502/503 responses
   - After max retries, yield structured error event ("I'm temporarily
     unavailable")
   - Per-provider `timeout` and `firstTokenTimeout` support

2. **`packages/core/src/providers/type-mappers.ts`** (~250 lines)
   - `geminiContentsToOpenAIMessages(contents: Content[], systemInstruction?: string): ChatCompletionMessageParam[]`
   - `geminiToolsToOpenAITools(tools: Tool[]): ChatCompletionTool[]`
   - `openAIChunkToGeminiResponse(chunk: ChatCompletionChunk): GenerateContentResponse`
   - `openAIResponseToGeminiResponse(response: ChatCompletion): GenerateContentResponse`
   - `openAIFinishReasonToGemini(reason: string): string`
   - `validateGeminiResponse(response: GenerateContentResponse): void` —
     assertion layer

3. **`packages/core/src/providers/registry.ts`** (~150 lines)
   - `ProviderRegistry` class
   - `create(config: ProviderConfig): ContentGenerator`
   - Provider config schema:
     ```typescript
     type ProviderConfig = {
       type: 'google-genai' | 'openai-compatible';
       apiKey: string;
       baseUrl?: string; // required for openai-compatible
       model: string;
       defaultHeaders?: Record<string, string>;
       timeout?: number; // request timeout ms
       firstTokenTimeout?: number; // time to first chunk ms
       retryAttempts?: number; // default 3
       retryBackoffMs?: number; // default 1000
     };
     ```

4. **`packages/core/src/providers/capability.ts`** (~80 lines)
   - `probeCapabilities(provider: ContentGenerator, model: string): ModelCapabilities`
   - Returns:
     `{ supportsToolCalling, supportsVision, supportsStreaming, maxContextTokens }`
   - Run on first connect, cache result
   - Graceful degradation: disable tools for models that don't support function
     calling

5. **`packages/core/src/providers/index.ts`** — barrel exports

6. **`packages/core/src/telemetry/mlflow-tracer.ts`** (~200 lines)
   - MLflow span emission for every agent operation using `mlflow-tracing`
     package
   - Span hierarchy:
     - `SpanType.AGENT` — wraps entire session lifecycle
     - `SpanType.CHAIN` — wraps each turn (prompt → response → tool calls → tool
       results)
     - `SpanType.LLM` — wraps each `generateContentStream()` /
       `generateContent()` call
       - Attributes: model, provider, baseUrl, promptTokens, completionTokens,
         latencyMs, finishReason
     - `SpanType.TOOL` — wraps each tool execution
       - Attributes: toolName, callId, status, durationMs, inputSize, outputSize
   - Init:
     `init({ trackingUri: process.env.MLFLOW_TRACKING_URI, experimentId: process.env.MLFLOW_EXPERIMENT_ID })`
   - Span creation: `withSpan(name, spanType, async (span) => { ... })`
   - Span renaming: `registerOnSpanEndHook()` for meaningful span names (e.g.,
     "turn:search-emails" instead of "turn:0")
   - **Graceful degradation**: if `MLFLOW_TRACKING_URI` not set, fall back to
     JSON structured logging to stdout
   - **No `experimental_telemetry` inside `withSpan` wrappers** (causes
     duplicate spans)
   - **No OTLP dual-export** (causes span duplication)
   - Wire into LoggingContentGenerator as replacement for Google telemetry

#### Files to Modify

1. **`packages/core/src/core/contentGenerator.ts`** (line 163-283)
   - In `createContentGenerator()`, add provider routing:
     ```typescript
     if (config.providerType === 'openai-compatible') {
       const provider = new OpenAICompatibleContentGenerator(config);
       return new LoggingContentGenerator(provider, gcConfig);
     }
     // existing Google GenAI path...
     ```

2. **`packages/core/src/config/config.ts`**
   - Add `providerType` to `ContentGeneratorConfig`
   - Add provider config section to `ConfigParameters`
   - Wire provider selection in `refreshAuth()`

3. **`packages/core/src/config/models.ts`**
   - Make `resolveModel()` provider-aware — pass through unknown model names for
     non-Google providers
   - Add model capability detection for non-Gemini models

#### What NOT to Touch

- `turn.ts` — reads GenerateContentResponse, our adapter produces valid ones
- `geminiChat.ts` — builds requests with Gemini types, our adapter consumes them
- `client.ts` — orchestrates turns, provider-agnostic
- `loggingContentGenerator.ts` — wraps any ContentGenerator, works as-is
- SDK layer — transparent
- Tool registry — unchanged
- MCP client manager — unchanged
- Session persistence — unchanged

#### Dependency to Add

- `openai` npm package (official OpenAI SDK, works with any compatible API)

### Testing Strategy

1. **Unit tests** for type mappers — exhaustive conversion tests
2. **Response validation tests** — malformed responses, missing fields, extra
   fields
3. **Streaming tool call state machine tests** — partial chunks, multi-tool,
   empty responses
4. **FakeContentGenerator pattern** — use existing test infrastructure
5. **Integration test** against local Ollama (free, no API key needed)
6. **Live test** against NVIDIA NIM with Nemotron — record session, replay in CI
7. **NIM spec diff** — record a real NIM session, diff against OpenAI spec,
   encode edge cases

### Edge Cases to Handle

- **Streaming tool calls**: OpenAI sends tool calls incrementally across chunks
  (partial function name, then partial args). Explicit state machine: accumulate
  tool_calls by index, buffer until `finish_reason` arrives, then yield complete
  `functionCalls[]`.
- **Multiple tool calls**: OpenAI can return multiple `tool_calls` in one
  response. Gemini's `functionCalls` is also an array — direct mapping.
- **Thoughts/thinking**: OpenAI doesn't have `part.thought`. Set to `false`
  always. If using a model with thinking (e.g., Claude via proxy), handle
  separately.
- **Content parts**: Gemini supports multiple parts per message. OpenAI has one
  `content` string. Join parts with newlines on the way out, single part on the
  way back.
- **Function call args**: Gemini sends `args` as object. OpenAI sends
  `arguments` as JSON string. Parse/stringify in mapper. **Catch malformed JSON
  — don't crash, yield error event.**
- **Empty response**: Model returns no text, no tool calls, no finish reason.
  Detect and yield `Finished` event with reason `EMPTY_RESPONSE`.
- **NIM non-standard fields**: Record real NIM responses, diff against spec,
  build adapter edge cases from the diff.
- **Object.setPrototypeOf**: First task — instantiate a real
  `GenerateContentResponse`, check if it validates. FakeContentGenerator does
  `Object.setPrototypeOf(response, GenerateContentResponse.prototype)` at line
  94 — we may need the same.

---

## Phase 2: Discord Bridge + SOUL.md Identity + Safety

**Delivers:** A working Discord bot with personality, rate limiting, file
handling, and input safety. SOUL.md merged in (trivial to implement, pointless
to ship without).

### Architecture

```
Discord.js Client
    │
    ├─ on('messageCreate')
    │   ├─ Preflight filter
    │   │   ├─ Ignore bots
    │   │   ├─ Rate limit check (per-user, per-channel token bucket)
    │   │   ├─ Input length check
    │   │   ├─ Channel binding check
    │   │   ├─ Role/permission check (optional allowedRoles)
    │   │   └─ Audit log (all inputs logged)
    │   │
    │   ├─ Message queue (serialize per-session — prevent concurrent corruption)
    │   │
    │   ├─ Content assembly
    │   │   ├─ message.content → text
    │   │   ├─ message.attachments → download, convert to content parts
    │   │   │   ├─ Images → inline for vision models
    │   │   │   ├─ Text files → extracted text
    │   │   │   └─ Other → description only
    │   │   └─ Thread context → if @mentioned in thread, fetch history
    │   │
    │   ├─ Route to agent session by channel/DM
    │   │   ├─ Channel → agent:{agentId}:discord:{channelId}
    │   │   └─ DM → agent:{agentId}:discord:dm:{userId}
    │   │
    │   └─ session.sendStream(assembledContent)
    │       ├─ GeminiEventType.Content → Discord message
    │       │   ├─ Stream via edit-in-place (throttled: 1 edit per 1.5s)
    │       │   ├─ Split at paragraph/code-block boundaries (not mid-block)
    │       │   └─ Rich embed formatting for code, headers
    │       ├─ GeminiEventType.ToolCallRequest → log or show approval buttons
    │       ├─ GeminiEventType.Finished → finalize message + emit cost event
    │       └─ GeminiEventType.Error → user-friendly error message
    │
    ├─ on('interactionCreate')
    │   ├─ Tool approval buttons (Allow / Deny)
    │   └─ Slash commands (/ask, /reset, /status, /memory)
    │
    ├─ Cost tracking
    │   └─ Every turn emits { agentId, channelId, userId, promptTokens, completionTokens, model, estimatedCost }
    │
    └─ Session persistence
        ├─ agent.resumeSession(channelSessionId) on reconnect
        └─ On crash recovery: detect partial messages, send "I was interrupted" + resume
```

### Identity Layer (SOUL.md) — Merged into Phase 2

**Pattern from OpenClaw — plain Markdown injected as system instruction.**

#### File Structure

```
agents/
├── nemotron/
│   ├── SOUL.md      — personality, communication style, guardrails
│   └── AGENTS.md    — capabilities, tool preferences, escalation rules
├── researcher/
│   ├── SOUL.md
│   └── AGENTS.md
```

#### How It Works

1. At session `initialize()`, read `SOUL.md` from agent workspace dir
2. Prepend to system instruction before first turn
3. If `AGENTS.md` exists, append as procedural context
4. **Hot-reload**: Watch files for changes — new sessions get new SOUL.md,
   existing sessions keep their version until explicit `/reset`
5. **Template variables**: Support `{{agent_name}}`, `{{channel_name}}`,
   `{{date}}` substitution
6. **Dynamic context injection**: Hook for per-message context —
   `contextProvider: (message) => string` appends to system instruction per turn
   (e.g., user roles, time of day)
7. **Size guard**: Warn if SOUL.md exceeds 2000 tokens (don't block, just warn
   in logs)

#### SOUL.md Template

```markdown
# Identity

You are {{agent_name}}. [One sentence about who you are.]

# Communication Style

- [How you talk]
- [What you avoid]
- [Tone and register]

# Guardrails

- [What you will not do]
- [When to escalate]
- [Safety boundaries]

# Knowledge

- [Domain expertise]
- [What you know well]
- [What you defer on]
```

#### Implementation

- Modify `packages/sdk/src/session.ts` line 93 (`initialize()`)
- Accept `agentDir?: string` in `GeminiCliAgentOptions`
- If set, read `SOUL.md` and `AGENTS.md` from that dir
- Prepend to `instructions` before passing to Config

### Key Design Decisions

- **One bot application per agent** (avoids Discord message filtering bug
  #11199)
- **Sessions isolated per channel/DM**: `agent:{agentId}:discord:{channelId}` or
  `agent:{agentId}:discord:dm:{userId}`
- **Thread context**: when @mentioned in thread, read full thread history via
  Discord API
- **Message chunking**: Discord has 2000 char limit — split at
  paragraph/code-block boundaries, not character count
- **Typing indicator**: Show typing continuously while model is generating
- **Concurrent message serialization**: Per-session message queue prevents
  Content[] corruption from simultaneous users
- **Discord rate limit respect**: Throttle message edits to 1 per 1.5 seconds,
  buffer text, batch edits

### Files to Create

```
packages/discord/
├── package.json
├── src/
│   ├── index.ts          — exports
│   ├── bridge.ts         — Discord.js ↔ SDK session wiring (~200 lines)
│   ├── router.ts         — message → agent routing by config (~100 lines)
│   ├── streaming.ts      — chunk streaming into Discord messages (~120 lines)
│   ├── buttons.ts        — tool approval interaction buttons (~60 lines)
│   ├── commands.ts        — slash command registration + handling (~80 lines)
│   ├── attachments.ts    — download + convert Discord attachments (~80 lines)
│   ├── ratelimit.ts      — token-bucket per-user and per-channel (~60 lines)
│   ├── preflight.ts      — input validation, length limits, audit logging (~60 lines)
│   ├── queue.ts          — per-session message serialization queue (~40 lines)
│   ├── cost.ts           — per-turn cost event emitter (~40 lines)
│   └── config.ts         — Discord-specific config types (~60 lines)
└── tsconfig.json
```

### Dependencies

- `discord.js` ^14.x
- `@google/gemini-cli-sdk` (our fork)

### Config Shape

```yaml
discord:
  agents:
    nemotron:
      botToken: $DISCORD_BOT_TOKEN
      provider: nvidia-nim
      model: nvidia/nemotron-3-super-120b-a12b
      soul: agents/nemotron/SOUL.md
      multimodal: true
      channels:
        - '1234567890' # allowed channel IDs, or "*" for all
      allowDMs: true
      allowedRoles: [] # empty = everyone, or ["admin", "member"]
      rateLimit:
        perUser:
          messages: 5
          windowSeconds: 60
        perChannel:
          messages: 20
          windowSeconds: 60
      inputMaxLength: 4000 # characters
```

### Slash Commands

| Command         | Action                                         |
| --------------- | ---------------------------------------------- |
| `/ask [prompt]` | Send prompt to agent (alternative to @mention) |
| `/reset`        | Clear session history for this channel         |
| `/status`       | Show agent health, model, session info         |
| `/memory`       | Show what the agent remembers about the user   |
| `/forget`       | Delete user-specific memory (GDPR)             |

---

## Phase 2.5: HTTP/Webhook API

**Delivers:** Universal transport for non-Discord integrations. Also makes
testing vastly easier.

### Why This Exists

Discord is one channel. Internal tools, Slack integrations, web UIs, CI/CD
pipelines, monitoring systems — all need to talk to the agent without Discord.
An HTTP endpoint is the universal adapter.

### Architecture

```
packages/http/
├── package.json
├── src/
│   ├── index.ts
│   ├── server.ts          — Express/Fastify server (~100 lines)
│   ├── routes/
│   │   ├── chat.ts        — POST /agent/:id/chat (send message, stream response)
│   │   ├── health.ts      — GET /agent/:id/health
│   │   ├── sessions.ts    — GET /agent/:id/sessions, DELETE /agent/:id/sessions/:sid
│   │   └── memory.ts      — GET/DELETE /agent/:id/memory/:userId
│   └── middleware/
│       ├── auth.ts        — API key or Bearer token auth
│       └── ratelimit.ts   — per-key rate limiting
└── tsconfig.json
```

### Endpoints

| Method   | Path                        | Description                                |
| -------- | --------------------------- | ------------------------------------------ |
| `POST`   | `/agent/:id/chat`           | Send message, get streaming response (SSE) |
| `GET`    | `/agent/:id/health`         | Agent health check                         |
| `GET`    | `/agent/:id/sessions`       | List active sessions                       |
| `DELETE` | `/agent/:id/sessions/:sid`  | Clear a session                            |
| `GET`    | `/agent/:id/memory/:userId` | Get user memory                            |
| `DELETE` | `/agent/:id/memory/:userId` | Delete user memory                         |

### Config

```yaml
http:
  enabled: true
  port: 3000
  auth:
    type: bearer # or api-key
    tokens: [$HTTP_API_TOKEN]
```

---

## Phase 3: Heartbeat + Alerting + Provider Fallback

**Delivers:** Auto-recovery, health monitoring with real alerting, provider
fallback chains.

### Architecture

```
HeartbeatService (interval: 60s, configurable)
    │
    ├─ Probes (cheap, deterministic — no LLM)
    │   ├─ Process alive? (pgrep)
    │   ├─ Discord WebSocket connected? (client.ws.status)
    │   ├─ API endpoint reachable? (HEAD request to provider baseUrl)
    │   ├─ Memory usage < threshold? (process.memoryUsage())
    │   ├─ Session count < limit? (prevent unbounded growth)
    │   └─ Last successful turn < timeout? (configurable, disabled by default)
    │
    ├─ All pass → emit "healthy" metric, continue
    │
    ├─ Probe fails → auto-fix tier 1
    │   ├─ Reconnect Discord
    │   ├─ Clear stale sessions (TTL-based)
    │   ├─ Trigger provider fallback if API probe failed
    │   └─ Force GC if memory probe failed
    │
    ├─ Auto-fix fails 3x → escalate tier 2
    │   ├─ Alert via Discord webhook to admin channel
    │   ├─ Alert via configurable webhook URL (Slack, PagerDuty, etc.)
    │   └─ Log detailed diagnostic with full probe results
    │
    └─ Escalation fails → tier 3 (optional)
        └─ Call headless Claude CLI for diagnosis
```

### Provider Fallback Chains

When the API probe detects provider failure, swap to fallback:

```yaml
agents:
  nemotron:
    provider: nvidia-nim
    model: nvidia/nemotron-3-super-120b-a12b
    fallback:
      - provider: ollama
        model: nemotron
      - provider: google
        model: gemini-2.0-flash
```

**Implementation:** `FallbackContentGenerator` wraps multiple providers. On
error, tries next in chain. Emits event when falling back so transport layer can
optionally notify user.

### Files to Create

```
packages/core/src/services/heartbeat.ts       — probe runner + scheduler (~200 lines)
packages/core/src/services/alerting.ts        — webhook/Discord alerting (~80 lines)
packages/core/src/services/probes/
  ├── process.ts
  ├── discord.ts
  ├── api.ts
  ├── memory.ts
  └── sessions.ts
packages/core/src/providers/fallback.ts       — FallbackContentGenerator (~100 lines)
```

### Probe Interface

```typescript
interface Probe {
  name: string;
  enabled: boolean;
  check(): Promise<{ ok: boolean; detail: string }>;
  fix?(): Promise<boolean>; // optional auto-fix
}
```

### Alerting Config

```yaml
heartbeat:
  intervalSeconds: 60
  alerts:
    discordWebhook: $ADMIN_DISCORD_WEBHOOK_URL # optional
    webhookUrl: $ALERT_WEBHOOK_URL # optional, for Slack/PagerDuty
  probes:
    memory:
      thresholdMb: 512
    sessions:
      maxCount: 100
    activity:
      enabled: false # disabled by default — false positive at 3 AM
      timeoutMinutes: 30
```

### Metrics Export

Every heartbeat tick emits structured JSON:

```json
{
  "timestamp": "2026-03-20T00:00:00Z",
  "agents": {
    "nemotron": {
      "healthy": true,
      "provider": "nvidia-nim",
      "activeSessions": 12,
      "memoryMb": 245,
      "totalTurns": 1847,
      "totalTokens": 2340000,
      "estimatedCostUsd": 4.68
    }
  }
}
```

---

## Phase 4: Multi-Agent Routing + Admin Controls

**Delivers:** Multiple agents in one process, isolated sessions, admin
management.

### Config

```yaml
agents:
  eli:
    soul: agents/eli/SOUL.md
    model: nvidia/nemotron-3-super-120b-a12b
    provider: nvidia-nim
    tools: ['*'] # all tools, or specific list
    discord:
      botToken: $DISCORD_BOT_TOKEN_ELI
      channels: ['123456789']
    resourceLimits:
      maxMemoryMb: 256
      maxTurnTimeoutMs: 120000
      maxSessionCount: 50
  researcher:
    soul: agents/researcher/SOUL.md
    model: grok-4-fast
    provider: grok
    tools: ['web-search', 'web-fetch', 'read-file']
    discord:
      botToken: $DISCORD_BOT_TOKEN_RESEARCHER
      channels: ['987654321']
```

### Key Patterns

- Each agent = own SDK session, own workspace dir, own SOUL.md, own session
  store
- Agents share the same process and tool registry (tools can be shared or scoped
  per agent)
- Each Discord bot = separate `discord.js` Client instance
- **Per-agent resource limits**: memory cap, turn timeout, session count limit
- **Agent lifecycle management**: Start/stop/restart individual agents without
  affecting others

### Inter-Agent Communication

Simple in-process event bus for agents sharing a process:

```typescript
interface AgentBus {
  send(from: string, to: string, message: string): void;
  on(agentId: string, handler: (from: string, message: string) => void): void;
}
```

Not enabled by default. Opt-in per agent:
`interAgent: { enabled: true, canTalkTo: ["researcher"] }`.

### Admin Controls

| Mechanism                | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `allowedRoles` per agent | Discord role-based access control                    |
| `blockedUsers` per agent | Block specific users                                 |
| Admin slash commands     | `/admin start/stop/restart <agent>`, `/admin status` |
| API key auth             | HTTP API requires authentication                     |
| Tool scoping             | Per-agent tool allowlist                             |

### Constraint Mitigations

- **One runaway agent kills all**: Per-agent memory limits + turn timeout.
  Heartbeat monitors per-agent health.
- **Process crash takes down all agents**: Heartbeat service restarts. In-flight
  state is lost but sessions resume from last checkpoint.
- **Session memory leak**: Auto-compress via `ChatCompressionService` (already
  exists in core). Session TTL eviction.

---

## Phase 5: Memory + Privacy + Export

**Delivers:** Cross-session memory, user-specific personalization, privacy
controls.

### What's Already There

- Sessions auto-saved to `~/.gemini/tmp/{projectId}/chats/` as JSON
- `agent.resumeSession(sessionId)` restores full history
- `chatRecordingService.ts` records every turn

### Enhancements

1. **MEMORY.md pattern** — auto-save important context before session ends (same
   as torad-toolkit)
2. **Per-channel resume** — when Discord bot restarts, resume last session per
   channel
3. **Memory search** — semantic search over past sessions using embeddings from
   the same provider
4. **User-specific memory** — `memory/{userId}.md` alongside channel sessions.
   Cross-channel, tied to Discord user ID. "Remember I prefer Python over
   JavaScript."
5. **Privacy controls** — `/forget` command clears user-specific memory and
   session history. GDPR-style right-to-forget.
6. **Memory inspection** — `/memory` command shows stored context for the
   requesting user. Structured answer, not hallucination.
7. **Memory limits & eviction** — Storage limits, TTL per session, eviction
   policy for oldest sessions.
8. **Conversation export** —
   `exportSession(sessionId, format: 'json' | 'markdown')` in SDK. Configurable
   storage backend (filesystem, SQLite, S3).

### Storage Architecture

```
~/.gemini/agents/{agentId}/
├── sessions/
│   ├── discord-{channelId}-{timestamp}.json
│   └── http-{sessionId}-{timestamp}.json
├── memory/
│   ├── {userId}.md          — per-user memory
│   └── channel-{channelId}.md — per-channel memory
└── MEMORY.md                 — agent-wide memory
```

---

## Strip List

### Remove Now

| What                                                                | Size       | Why                                     |
| ------------------------------------------------------------------- | ---------- | --------------------------------------- |
| `packages/vscode-ide-companion/`                                    | 96K        | IDE extension, not needed               |
| `packages/a2a-server/`                                              | 388K       | Agent-to-agent server, evaluate later   |
| `packages/devtools/`                                                | 20K        | Keep in repo but don't build by default |
| `sea/`                                                              | —          | Single executable packaging, not needed |
| Google telemetry in `packages/core/src/telemetry/`                  | —          | Replace with mlflow-tracer.ts           |
| `CoreToolScheduler` (`packages/core/src/core/coreToolScheduler.ts`) | 1109 lines | Legacy, replaced by modern `Scheduler`  |

### Keep

| What                     | Why                                                    |
| ------------------------ | ------------------------------------------------------ |
| `packages/core/`         | The engine — agent loop, tools, MCP, sessions          |
| `packages/sdk/`          | Clean programmatic API — our primary interface         |
| `packages/cli/`          | Keep for debugging/development, not primary interface  |
| `packages/test-utils/`   | Test infrastructure                                    |
| MCP integration          | Free tool ecosystem                                    |
| Session persistence      | Already works                                          |
| Modern `Scheduler`       | Tool execution orchestration                           |
| `ChatCompressionService` | Context window management — critical for long sessions |

### Evaluate Later

| What                           | Why                                                 |
| ------------------------------ | --------------------------------------------------- |
| `packages/a2a-server/`         | Agent-to-agent could be useful for multi-agent chat |
| Google OAuth flows             | Keep but make optional, not default                 |
| Browser automation (puppeteer) | Heavy dep, useful for web tools                     |

---

## Implementation Order

```
Phase 1: OpenAI ContentGenerator + Structured Logging + Graceful Degradation
    │       + Response Validation + Capability Probing
    │
    ├─ Test with Ollama locally
    ├─ Test with NVIDIA NIM (record session, encode edge cases)
    └─ Test with Grok API
    │
Phase 2: Discord Bridge + SOUL.md Identity + Rate Limiting + File Handling
    │       + Slash Commands + DM Support + Concurrent Message Queue
    │       + Cost Tracking + Input Safety + Crash Recovery
    │
    ├─ Single agent, single channel, streaming responses
    ├─ Add attachments, slash commands, DM
    └─ Add rate limiting, input validation, cost events
    │
Phase 2.5: HTTP/Webhook API
    │
    ├─ POST /agent/:id/chat with SSE streaming
    └─ Health, sessions, memory endpoints
    │
Phase 3: Heartbeat + Alerting + Provider Fallback Chains
    │
    ├─ Cheap probes, auto-fix tiers
    ├─ Discord webhook + generic webhook alerts
    └─ FallbackContentGenerator for provider chains
    │
Phase 4: Multi-Agent Routing + Admin Controls + Resource Isolation
    │
    ├─ Multiple agents, isolated sessions
    ├─ Per-agent resource limits
    ├─ Inter-agent event bus (opt-in)
    └─ Admin slash commands
    │
Phase 5: Memory + User-Specific Memory + Privacy + Export
    │
    ├─ MEMORY.md pattern
    ├─ Per-user memory tied to Discord user ID
    ├─ /forget, /memory commands
    └─ Session export (JSON, Markdown)
```

**Key principle:** Every phase produces a working, testable artifact. No
big-bang rewrites. After Phase 1 + 2, you have a Discord bot running Nemotron
with personality, rate limiting, and file handling. Everything after that is
incremental.

---

## Build & Dev Setup

### First Time

```bash
npm install
npm run build
# Test existing CLI still works:
npx gemini --help
```

### Development Workflow

```bash
# Build core + sdk after changes:
npm run build -w packages/core -w packages/sdk

# Run tests:
npm test -w packages/core

# Test with Ollama (free, local):
GEMINI_API_KEY=ollama GOOGLE_GENAI_BASE_URL=http://localhost:11434 npx gemini
```

### New Package (discord)

```bash
mkdir -p packages/discord/src
# Add to root package.json workspaces
# Add package.json with @google/gemini-cli-sdk dependency
```

---

## Existing Test Infrastructure

- **FakeContentGenerator** (`fakeContentGenerator.ts`) — canned responses from
  JSON files
- **RecordingContentGenerator** (`recordingContentGenerator.ts`) — records API
  calls for replay
- **`--fake-responses` / `--record-responses` flags** — built into CLI
- **Vitest** — test runner
- Pattern: record a real session, replay it in tests

For our OpenAI provider: record an OpenAI/NIM session, write mapper tests
against the recorded responses.

---

## Risk Register

| Risk                                                | Severity | Mitigation                                                                                                                                                                                          |
| --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GenerateContentResponse has methods, not just data  | High     | First task: instantiate real one, check if constructor validates. FakeContentGenerator uses `Object.setPrototypeOf` at line 94 — we may need the same                                               |
| Streaming tool calls arrive incrementally           | High     | Explicit state machine: accumulate by index, buffer until `finish_reason`, then yield complete                                                                                                      |
| NIM returns non-standard OpenAI response            | High     | Record real NIM session, diff against spec, build adapter edge cases from diff                                                                                                                      |
| LoggingContentGenerator reads fields we don't set   | Medium   | Audit every field access in loggingContentGenerator.ts (lines 537-557) — `response.candidates`, `response.usageMetadata`, `response.responseId`, `response.modelVersion`, `response.promptFeedback` |
| Config.ts is 31K lines                              | Medium   | Touch minimally — add provider config, don't refactor                                                                                                                                               |
| Model resolution assumes Gemini names               | Medium   | Make `resolveModel()` pass through unknown model names for non-Google providers                                                                                                                     |
| Two users message same channel simultaneously       | High     | Per-session message queue serializes incoming messages                                                                                                                                              |
| Session history exceeds context window              | Medium   | Already handled by `ChatCompressionService` in core — verify it works with non-Gemini providers                                                                                                     |
| Memory leak from accumulated sessions               | High     | Session TTL, auto-eviction, per-agent memory limits, heartbeat memory probe                                                                                                                         |
| Bot process crash with in-flight messages           | Medium   | On reconnect, detect partial messages, send "I was interrupted" + resume session                                                                                                                    |
| Malformed JSON in tool call arguments               | Medium   | try/catch in mapper, yield error event to model for self-correction, don't crash turn loop                                                                                                          |
| Empty model response (no text, no tools, no finish) | Medium   | Detect, yield `Finished` with `EMPTY_RESPONSE` reason                                                                                                                                               |
| Discord rate limits during high traffic             | Medium   | Throttle message edits to 1/1.5s, buffer text, batch edits                                                                                                                                          |
| API key rotation while bot is running               | Low      | Config hot-reload support — watch env vars or config file                                                                                                                                           |
| OpenAI npm package updates change types             | Medium   | Pin version, update deliberately, type-mappers isolate the boundary                                                                                                                                 |
| Upstream gemini-cli pushes breaking changes         | Medium   | Keep fork minimal — touch few files, merge upstream regularly, adapter is isolated                                                                                                                  |
| SOUL.md prompt injection                            | Low      | Validate on load, warn on suspicious patterns. Operator-controlled file, not user input                                                                                                             |
| Public bot prompt injection from users              | High     | Input length limits, audit logging, optional keyword blocklist in preflight filter                                                                                                                  |

---

## Structural Decisions (Hard to Change Later)

1. **Adapter at ContentGenerator level** — This is the right seam but locks us
   into producing `GenerateContentResponse` objects forever. If `@google/genai`
   changes that type, every adapter breaks. **Mitigation:** Pin `@google/genai`
   version. Our adapters are the only code that imports the type constructors.

2. **`openai` npm package as dependency** — If OpenAI changes the SDK
   significantly, our type-mappers break. **Mitigation:** type-mappers.ts is the
   isolation boundary. Pin version. All OpenAI types stay in that one file.

3. **One process, multiple agents** — Simpler to build but couples agent
   lifecycles. A process-per-agent model is harder to add later. **Mitigation:**
   Agent lifecycle management in Phase 4. Evaluate process-per-agent if resource
   isolation becomes critical.

---

## Rejection Framework (What We Will NOT Build)

These are patterns, features, and approaches that are explicitly out of scope —
not because they're bad ideas, but because they pull us toward complexity that
doesn't serve the goal. Every rejection has a reason. If the reason stops being
true, revisit.

### Architectural Rejections

| Rejected                                                                                                                                        | Why                                                                                                                                                                                          | What To Do Instead                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Programmatic orchestration replacing LLM dispatch** — no `for` loops, no `Promise.all`, no state machines replacing the model's tool dispatch | LLM-driven orchestration gives retry, telemetry, repair, and observability for free. A hand-rolled loop gives nothing.                                                                       | Let the model drive tool execution through the existing Scheduler.                                    |
| **Custom agent loop** — rewriting GeminiClient, Turn, or GeminiChat                                                                             | The existing loop is 2800+ lines of battle-tested code with compression, retry, loop detection, and error handling. Rewriting it is months of work for zero gain.                            | Adapter pattern at ContentGenerator. Don't touch the loop.                                            |
| **Abstract provider interface** beyond ContentGenerator                                                                                         | Over-engineering. ContentGenerator is already the interface. Adding another abstraction layer (ProviderAdapter → ContentGenerator → LoggingContentGenerator) adds indirection without value. | One adapter class per provider type. That's it.                                                       |
| **Plugin system** for providers                                                                                                                 | We don't need dynamic provider loading, plugin discovery, or marketplace. We need 2-3 providers that work.                                                                                   | Hard-code provider types in ProviderRegistry. Add new ones as source files, not plugins.              |
| **Database-backed session storage** at launch                                                                                                   | SQLite/Postgres adds operational complexity (migrations, backups, connection management). JSON files work.                                                                                   | Filesystem JSON for now. Add configurable backend in Phase 5 only if filesystem proves insufficient.  |
| **Kubernetes / container orchestration**                                                                                                        | We're running on one machine. K8s is a deployment tax with zero benefit at this scale.                                                                                                       | systemd user service. Same pattern as the NemoClaw monitor.                                           |
| **Microservice architecture** — splitting agents into separate services with message queues                                                     | Adds network hops, serialization overhead, deployment complexity, and distributed debugging pain. All for a system that runs fine in one process.                                            | One process, multiple agents. Evaluate process-per-agent only if resource isolation becomes critical. |

### Feature Rejections

| Rejected                                                                       | Why                                                                                                               | What To Do Instead                                                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Web UI / Dashboard**                                                         | Building a frontend is a separate project. The plan is an agent runtime, not a SaaS product.                      | Use Discord as the UI. HTTP API for programmatic access. Grafana for metrics if needed.          |
| **User authentication / accounts**                                             | Discord handles auth. HTTP API uses bearer tokens. We don't need our own user system.                             | Rely on Discord identity (user ID) and API key auth for HTTP.                                    |
| **Billing / payment integration**                                              | Cost tracking yes. Billing no. We're not selling this as a service.                                               | Emit cost events. Aggregate in logs or external tool.                                            |
| **Voice / audio support**                                                      | Discord voice channels are a completely different integration (WebRTC, audio processing, STT/TTS). Massive scope. | Text only. If voice is needed later, it's a separate transport package.                          |
| **Training / fine-tuning pipeline**                                            | We consume models, we don't train them.                                                                           | Use pre-trained models via API. Fine-tuning happens elsewhere (torad-toolkit training pipeline). |
| **Model evaluation / benchmarking**                                            | Out of scope for the runtime. Evaluation is a separate concern.                                                   | Use existing eval tools. The runtime doesn't judge model quality.                                |
| **Multi-tenant isolation** — separate data/config per organization             | This is a personal/team tool, not a multi-tenant platform.                                                        | Single-tenant. One config, one operator, multiple agents.                                        |
| **Automatic SOUL.md generation** — LLM writes its own personality              | The operator defines personality. The model doesn't get to rewrite its own identity. That's a safety boundary.    | SOUL.md is human-written, human-reviewed, human-deployed.                                        |
| **Real-time collaboration** — multiple operators editing config simultaneously | We're not building Google Docs for agent config.                                                                  | Config is a YAML file. Use git for collaboration.                                                |
| **Backwards compatibility with OpenClaw config format**                        | We're not migrating OpenClaw users. We stole patterns, not the config schema.                                     | Our own config format, designed for our needs.                                                   |

### Process Rejections

| Rejected                                                                                         | Why                                                                                  | What To Do Instead                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| **Big-bang rewrite** of any core package                                                         | Every phase must produce a working artifact. No "we'll integrate it all at the end." | Incremental delivery. Phase 1 works alone. Phase 2 builds on Phase 1.                  |
| **Speculative features** — building for hypothetical users                                       | We're building for Marcos's Discord server with 3 agents. Not for 10,000 users.      | Solve the problem in front of us. Generalize only when a second real use case appears. |
| **Premature abstraction** — creating helpers, utilities, or base classes for one-time operations | Three similar lines of code is better than a premature abstraction.                  | Write the concrete thing. Extract only when the third instance appears.                |
| **Documentation-first development** — writing docs before code works                             | Docs rot. Working code with clear names is the documentation.                        | Code first. PLAN.md is the roadmap. Code comments only where logic isn't self-evident. |
| **Feature flags / backwards-compatibility shims**                                                | If we're changing something, change it. Don't maintain two code paths.               | Just change the code. We own the fork. No external consumers to break.                 |

---

## Acceptance Criteria

### Phase 1: OpenAI ContentGenerator — DONE when:

- [ ] `OpenAICompatibleContentGenerator` implements all 4 `ContentGenerator`
      methods
- [ ] Type mappers convert Gemini ↔ OpenAI request/response formats correctly
- [ ] Streaming works end-to-end: SSE chunks → `GenerateContentResponse` objects
      → Turn.ts yields events
- [ ] Streaming tool calls buffer correctly (partial chunks assembled into
      complete `functionCalls[]`)
- [ ] `Object.setPrototypeOf` verified — constructed responses pass through
      Turn.ts and LoggingContentGenerator without errors
- [ ] Empty response detected and yields `Finished` event (not silent hang)
- [ ] Malformed tool call JSON caught and yielded as error event (not crash)
- [ ] Retry with backoff for 429/502/503 responses — max 3 retries, then
      structured error event
- [ ] Structured logger emits JSON per-turn with sessionId, agentId, model,
      token counts, latency
- [ ] Unit tests pass for all type mapper functions (≥20 test cases covering
      edge cases)
- [ ] Integration test passes against local Ollama (text generation + tool
      calling)
- [ ] Live test passes against NVIDIA NIM with Nemotron (text generation + tool
      calling)
- [ ] Existing Gemini CLI still works unchanged (`npx gemini --help`, basic
      conversation)
- [ ] ProviderRegistry routes to correct ContentGenerator based on config
- [ ] `resolveModel()` passes through non-Gemini model names without error

### Phase 2: Discord Bridge + SOUL.md — DONE when:

- [ ] Bot connects to Discord and shows as online
- [ ] Bot responds to messages in configured channels with streaming
      (edit-in-place)
- [ ] Bot responds to DMs
- [ ] SOUL.md loaded and injected as system instruction — bot exhibits
      configured personality
- [ ] SOUL.md template variables (`{{agent_name}}`, `{{date}}`) resolved at load
      time
- [ ] SOUL.md hot-reload — file change picked up on next new session
- [ ] Slash commands registered and functional: `/ask`, `/reset`, `/status`
- [ ] Discord attachments (images, text files) downloaded and included in model
      context
- [ ] Rate limiting enforced — user exceeding limit gets "slow down" message
- [ ] Input length limit enforced — oversized messages rejected with explanation
- [ ] Two users messaging the same channel simultaneously — no session
      corruption (queue works)
- [ ] Long responses split at paragraph/code-block boundaries (not mid-block)
- [ ] Typing indicator shown while model generates
- [ ] Message edits throttled to respect Discord rate limits (no 429s from
      Discord)
- [ ] Cost event emitted per turn with agentId, channelId, userId, token counts
- [ ] All user inputs audit-logged (structured JSON)
- [ ] Bot survives restart — resumes last session per channel
- [ ] Bot handles model API error gracefully — user sees friendly message, not
      stack trace

### Phase 2.5: HTTP API — DONE when:

- [ ] `POST /agent/:id/chat` accepts text prompt, returns SSE stream of events
- [ ] `GET /agent/:id/health` returns agent status
- [ ] `GET /agent/:id/sessions` lists active sessions
- [ ] `DELETE /agent/:id/sessions/:sid` clears a session
- [ ] Bearer token auth enforced — unauthenticated requests rejected
- [ ] Rate limiting per API key
- [ ] Same agent accessible via both Discord and HTTP simultaneously

### Phase 3: Heartbeat + Alerting + Fallback — DONE when:

- [ ] Heartbeat runs every 60s (configurable)
- [ ] All probes functional: process, Discord WS, API endpoint, memory, session
      count
- [ ] Probe failure triggers auto-fix (reconnect Discord, clear stale sessions)
- [ ] 3 consecutive auto-fix failures triggers alert
- [ ] Alert delivered via Discord webhook to admin channel
- [ ] Alert delivered via configurable webhook URL (Slack/PagerDuty compatible)
- [ ] Structured metrics JSON emitted per heartbeat tick
- [ ] Provider fallback chain works: NIM down → Ollama → Gemini (configurable)
- [ ] Fallback event emitted so transport layer can optionally notify user
- [ ] Heartbeat service itself is fault-tolerant (doesn't crash on probe error)

### Phase 4: Multi-Agent — DONE when:

- [ ] 2+ agents running in one process with isolated sessions
- [ ] Each agent has own SOUL.md, own session store, own provider config
- [ ] Each agent has own Discord bot (separate token, separate Client instance)
- [ ] Tool scoping works — agent only sees tools in its allowlist
- [ ] Per-agent memory limit enforced — agent exceeding limit gets sessions
      evicted
- [ ] Per-agent turn timeout enforced — stuck turn cancelled after limit
- [ ] Admin slash commands work: `/admin status`, `/admin restart <agent>`
- [ ] Inter-agent event bus works (opt-in): agent A sends message to agent B
- [ ] One agent crashing/stalling doesn't kill other agents

### Phase 5: Memory + Privacy — DONE when:

- [ ] MEMORY.md auto-saved before session ends with key context
- [ ] Session resumes after bot restart with full history
- [ ] User-specific memory stored per Discord user ID, accessible cross-channel
- [ ] `/memory` shows user what the agent remembers about them
- [ ] `/forget` deletes all user-specific memory and session history
- [ ] Memory limits enforced — oldest sessions evicted when storage exceeds
      threshold
- [ ] Session export works: `exportSession(id, 'json')` and
      `exportSession(id, 'markdown')`
- [ ] Semantic search over past sessions returns relevant context for new
      conversations
