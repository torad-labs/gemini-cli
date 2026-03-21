# OpenAI Provider — Architecture

## Layer Diagram

```
Existing Stack (UNTOUCHED)
┌─────────────────────────────────────────────┐
│  SDK: GeminiCliAgent → GeminiCliSession     │
│  ↓                                          │
│  Core: GeminiClient → Turn → GeminiChat     │
│  ↓                                          │
│  LoggingContentGenerator (wraps any CG)     │
└─────────────┬───────────────────────────────┘
              │
              │ ContentGenerator interface
              │ (4 methods, @google/genai types)
              │
┌─────────────▼───────────────────────────────┐
│  NEW: Provider Layer                         │
│                                              │
│  ProviderRegistry                            │
│    ├─ type: 'google-genai' → existing path   │
│    └─ type: 'openai-compatible' → new path   │
│                                              │
│  OpenAICompatibleContentGenerator            │
│    ├─ type-mappers.ts (format conversion)    │
│    ├─ StreamingToolCallBuffer (chunk assembly)│
│    └─ retry + timeout + error handling       │
│                                              │
│  capability.ts (probe model features)        │
│  structured-logger.ts (JSON telemetry)       │
└──────────────────────────────────────────────┘
```

## Data Flow: Streaming Request

```
1. SDK calls session.sendStream("hello")
2. GeminiClient.sendMessageStream() called
3. GeminiChat builds GenerateContentParameters:
   { model, contents: Content[], config: { systemInstruction, tools } }
4. Calls contentGenerator.generateContentStream(params, promptId, role)

   ┌─ IF google-genai ──────────────────────────┐
   │  GoogleGenAI.models.generateContentStream() │
   │  Returns AsyncGenerator<GCResponse>         │
   └────────────────────────────────────────────┘

   ┌─ IF openai-compatible ─────────────────────────────────┐
   │  a. geminiContentsToOpenAIMessages(contents, sysInstr) │
   │  b. geminiToolsToOpenAITools(tools)                    │
   │  c. openai.chat.completions.create({ stream: true })   │
   │  d. For each SSE chunk:                                │
   │     - Text → openAIChunkToGeminiResponse(chunk)        │
   │     - Tool delta → buffer.accumulate(delta)            │
   │     - finish_reason → buffer.flush() if tool calls     │
   │  e. Yield GenerateContentResponse per chunk            │
   └────────────────────────────────────────────────────────┘

5. LoggingContentGenerator wraps stream, logs telemetry
6. Turn.run() reads response:
   - resp.candidates[0].content.parts[] → text events
   - resp.functionCalls[] → tool call request events
   - resp.candidates[0].finishReason → finished event
   - resp.usageMetadata → token tracking
7. GeminiClient yields ServerGeminiStreamEvent to SDK
8. SDK yields to caller
```

## Data Flow: Tool Call Round-Trip

```
1. Model response includes functionCalls[{ id, name, args }]
2. Turn.run() yields ToolCallRequest event
3. Scheduler executes tool, gets result
4. Result packaged as Content:
   { role: 'user', parts: [{ functionResponse: { name, response } }] }
5. Sent back via GeminiChat.sendMessageStream()
6. ContentGenerator receives it in contents[]

   ┌─ IF openai-compatible ──────────────────────────────┐
   │  type-mappers converts functionResponse part to:    │
   │  { role: 'tool', tool_call_id: id,                 │
   │    content: JSON.stringify(response) }              │
   └────────────────────────────────────────────────────┘

7. Model sees tool result, generates next response
8. Loop continues until model stops calling tools
```

## Streaming Tool Call Assembly

OpenAI sends tool calls incrementally. This is the state machine:

```
State: IDLE
  │
  ├─ Chunk has delta.content → yield text response, stay IDLE
  │
  ├─ Chunk has delta.tool_calls[N] with id + name
  │   → Create buffer entry for index N
  │   → State: BUFFERING
  │
State: BUFFERING
  │
  ├─ Chunk has delta.tool_calls[N] with arguments fragment
  │   → Append to buffer[N].arguments
  │   → Stay BUFFERING
  │
  ├─ Chunk has delta.tool_calls[M] with id + name (M ≠ N)
  │   → Create new buffer entry for index M
  │   → Stay BUFFERING (multiple parallel tool calls)
  │
  ├─ Chunk has finish_reason = "tool_calls"
  │   → Flush all buffers:
  │     - JSON.parse(arguments) for each → args object
  │     - Construct functionCalls[] array
  │   → Yield GenerateContentResponse with functionCalls
  │   → State: IDLE
  │
  ├─ JSON.parse fails on arguments
  │   → Yield error event (don't crash)
  │   → State: IDLE
```

## Error Handling Strategy

```
API call
  │
  ├─ 200 OK → process normally
  │
  ├─ 429 Rate Limited → retry after backoff (1s, 2s, 4s), max 3
  │
  ├─ 502/503 Server Error → retry after backoff, max 3
  │
  ├─ 401/403 Auth Error → yield error event immediately (no retry)
  │
  ├─ Timeout (no first chunk within firstTokenTimeout)
  │   → yield error event: "Model is taking too long to respond"
  │
  ├─ Stream interrupted mid-response
  │   → yield what we have + error event
  │
  ├─ Empty response (no text, no tools, no finish)
  │   → yield Finished event with reason EMPTY_RESPONSE
  │
  └─ All retries exhausted
      → yield error event: "I'm temporarily unavailable. Try again in a minute."
```

## Architecture Boundaries

```
ALLOWED IMPORTS:
  providers/openai-compatible.ts → imports from:
    - openai (npm package)
    - providers/type-mappers.ts
    - @google/genai types (GenerateContentResponse, etc.)

  providers/type-mappers.ts → imports from:
    - @google/genai types
    - openai types

  providers/registry.ts → imports from:
    - providers/openai-compatible.ts
    - core/contentGenerator.ts (ContentGenerator interface)

  providers/capability.ts → imports from:
    - core/contentGenerator.ts (ContentGenerator interface)

  core/contentGenerator.ts → imports from:
    - providers/registry.ts (new import)

  config/config.ts → imports from:
    - providers/registry.ts (for config types)

FORBIDDEN IMPORTS:
  providers/* → NEVER imports from cli/, sdk/, tools/, scheduler/
  providers/* → NEVER imports from config/config.ts (too heavy, circular risk)
  turn.ts → NEVER imports from providers/* (it only sees ContentGenerator interface)
  geminiChat.ts → NEVER imports from providers/*
```

## Config Integration

The provider config enters through `ContentGeneratorConfig`:

```typescript
// Added to existing ContentGeneratorConfig type:
interface ContentGeneratorConfig {
  // ... existing fields ...
  providerType?: 'google-genai' | 'openai-compatible';
  openaiConfig?: {
    baseUrl: string;
    model: string;
    defaultHeaders?: Record<string, string>;
    timeout?: number;
    firstTokenTimeout?: number;
    retryAttempts?: number;
    retryBackoffMs?: number;
  };
}
```

Set via environment variables:

```bash
# Use OpenAI-compatible provider:
PROVIDER_TYPE=openai-compatible
OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
OPENAI_API_KEY=$NVIDIA_API_KEY
OPENAI_MODEL=nvidia/nemotron-3-super-120b-a12b

# Or keep using Gemini (default, no changes):
GEMINI_API_KEY=your-key
```
