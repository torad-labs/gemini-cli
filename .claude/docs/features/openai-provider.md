# OpenAI-Compatible Content Generator

## What

An adapter that implements the `ContentGenerator` interface using any
OpenAI-compatible API (NVIDIA NIM, Grok/xAI, Ollama, OpenAI itself). Converts
between Gemini and OpenAI request/response formats so the entire agent stack
works with any model provider.

## Why

The gemini-cli core is hardcoded to `@google/genai`. Every layer above
`ContentGenerator` (Turn, GeminiChat, GeminiClient, SDK) consumes
`GenerateContentResponse` objects. By implementing the adapter at this seam, we
get multi-provider support without touching 4000+ lines of battle-tested agent
loop code.

## Build Sequence

### Step 1: Verify GenerateContentResponse construction pattern

Before writing any adapter code, determine how `GenerateContentResponse` objects
are actually created in the codebase:

1. Read `packages/core/src/core/fakeContentGenerator.ts` — how does it construct
   responses? Does it use `Object.setPrototypeOf`?
2. Read `@google/genai` source in `node_modules` — is `GenerateContentResponse`
   a class with validation, or a plain type?
3. Read `packages/core/src/core/turn.ts` lines 308-359 — what exact fields are
   accessed on the response?
4. Read `packages/core/src/core/loggingContentGenerator.ts` lines 537-557 — what
   fields does logging access?
5. Read `packages/core/src/core/geminiChat.ts` — how are function responses sent
   back? What's the `Content` shape for tool results?

**Output:** A verified response construction recipe — the exact code needed to
build a `GenerateContentResponse` that passes through Turn.ts and
LoggingContentGenerator without errors.

### Step 2: Install OpenAI SDK and verify types

1. `npm install openai -w packages/core`
2. Read `node_modules/openai/resources/chat/completions.ts` — verify the actual
   `ChatCompletionChunk` type shape
3. Verify streaming API: `client.chat.completions.create({ stream: true })`
4. Verify `tool_calls` field structure in streaming chunks
5. Check how streaming tool calls arrive incrementally

**Output:** A verified OpenAI type reference — the exact fields we'll map from.

### Step 3: Build type-mappers.ts

Create `packages/core/src/providers/type-mappers.ts`:

Functions to implement:

- `geminiContentsToOpenAIMessages(contents, systemInstruction)` — convert Gemini
  Content[] to OpenAI messages[]
- `geminiToolsToOpenAITools(tools)` — convert Gemini tool declarations to OpenAI
  tool format
- `openAIChunkToGeminiResponse(chunk, bufferedToolCalls)` — convert a single
  streaming chunk to GenerateContentResponse, using the verified construction
  pattern from Step 1
- `openAIResponseToGeminiResponse(response)` — convert non-streaming response
- `openAIFinishReasonToGemini(reason)` — map finish reason strings
- `validateGeminiResponse(response)` — assert required fields exist

Key mappings (see PLAN.md for full table):

- `contents[].role: "model"` → `messages[].role: "assistant"`
- `contents[].parts[].functionCall` → `messages[].tool_calls[]`
- `contents[].parts[].functionResponse` → `messages[] { role: "tool" }`
- `choices[0].delta.content` → `candidates[0].content.parts[{ text }]`
- `choices[0].delta.tool_calls` → `functionCalls[]` (DIRECT on response)

### Step 4: Build streaming tool call buffer

OpenAI sends tool calls incrementally across chunks:

- Chunk 1:
  `tool_calls[0] = { index: 0, id: "call_abc", function: { name: "read" } }`
- Chunk 2: `tool_calls[0] = { index: 0, function: { arguments: '{"path":' } }`
- Chunk 3: `tool_calls[0] = { index: 0, function: { arguments: '"/tmp/f"}' } }`

Build a `StreamingToolCallBuffer` class:

- `accumulate(toolCallDelta)` — merge incremental chunks by index
- `isComplete(finishReason)` — true when finish_reason arrives
- `flush(): FunctionCall[]` — return complete tool calls, parse JSON args
- Handle malformed JSON in arguments — try/catch, don't crash

### Step 5: Build openai-compatible.ts

Create `packages/core/src/providers/openai-compatible.ts`:

```typescript
class OpenAICompatibleContentGenerator implements ContentGenerator {
  constructor(config: OpenAIProviderConfig);

  async generateContent(
    request,
    userPromptId,
    role,
  ): Promise<GenerateContentResponse>;
  async *generateContentStream(
    request,
    userPromptId,
    role,
  ): AsyncGenerator<GenerateContentResponse>;
  async countTokens(request): Promise<CountTokensResponse>;
  async embedContent(request): Promise<EmbedContentResponse>;
}
```

For `generateContentStream`:

1. Convert request via type-mappers
2. Call OpenAI SDK with `stream: true`
3. For each chunk:
   - If text content: yield GenerateContentResponse with text part
   - If tool call delta: accumulate in StreamingToolCallBuffer
   - If finish_reason and buffer has tool calls: flush buffer, yield response
     with functionCalls
   - If finish_reason without tool calls: yield final response
4. Handle errors:
   - 429/502/503: retry with exponential backoff (max 3 attempts)
   - Timeout: yield error event
   - Empty response: yield Finished with EMPTY_RESPONSE reason
   - Malformed response: yield error event, don't crash

For `countTokens`:

- If provider has token counting endpoint: use it
- Otherwise: estimate based on character count / 4 (rough approximation)

For `embedContent`:

- Call `/embeddings` endpoint
- Map response to `EmbedContentResponse` shape

### Step 6: Build registry.ts

Create `packages/core/src/providers/registry.ts`:

```typescript
class ProviderRegistry {
  create(config: ProviderConfig): ContentGenerator;
}

type ProviderConfig = {
  type: 'google-genai' | 'openai-compatible';
  apiKey: string;
  baseUrl?: string;
  model: string;
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  firstTokenTimeout?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
};
```

Routes to `OpenAICompatibleContentGenerator` or existing Google GenAI path.

### Step 7: Build capability.ts

Create `packages/core/src/providers/capability.ts`:

```typescript
async function probeCapabilities(
  provider: ContentGenerator,
  model: string,
): Promise<ModelCapabilities>;

type ModelCapabilities = {
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  maxContextTokens?: number;
};
```

- Send a minimal test request with one tool declaration
- If the model returns a tool call or acknowledges tools:
  `supportsToolCalling = true`
- If it errors on tools: `supportsToolCalling = false`, disable tools for this
  model
- Cache result per model string

### Step 8: Build mlflow-tracer.ts

Create `packages/core/src/telemetry/mlflow-tracer.ts`:

1. `npm install mlflow-tracing -w packages/core`
2. Init pattern:
   `init({ trackingUri: process.env.MLFLOW_TRACKING_URI, experimentId: process.env.MLFLOW_EXPERIMENT_ID })`
3. Export helper functions:
   - `traceSession(sessionId, agentId, fn)` — wraps in `SpanType.AGENT`
   - `traceTurn(turnId, fn)` — wraps in `SpanType.CHAIN`
   - `traceLlmCall(model, provider, fn)` — wraps in `SpanType.LLM`, records
     token counts + latency as attributes
   - `traceToolCall(toolName, callId, fn)` — wraps in `SpanType.TOOL`, records
     status + duration
4. Use `registerOnSpanEndHook()` for meaningful span names
5. **Graceful degradation**: if `MLFLOW_TRACKING_URI` not set, all trace
   functions become pass-through (execute fn, skip span creation). Fall back to
   JSON logging to stdout.
6. **No `experimental_telemetry` inside `withSpan` wrappers** (causes duplicate
   spans)
7. **No OTLP dual-export** (causes span duplication)
8. Wire into LoggingContentGenerator: replace Google telemetry events with
   MLflow span calls

### Step 9: Wire into contentGenerator.ts

Modify `packages/core/src/core/contentGenerator.ts`:

- In `createContentGenerator()` (line ~271), add provider routing
- If `config.providerType === 'openai-compatible'`: create via ProviderRegistry
- Else: existing Google GenAI path unchanged

### Step 10: Wire into config.ts

Modify `packages/core/src/config/config.ts`:

- Add `providerType` field to `ContentGeneratorConfig`
- Add provider config to `ConfigParameters`
- Wire provider selection in `refreshAuth()`
- Touch MINIMALLY — this file is 31K lines

### Step 11: Wire into models.ts

Modify `packages/core/src/config/models.ts`:

- In `resolveModel()`: if provider is not Google, pass through the model name
  without alias resolution
- Skip `isPreviewModel()`, `isGemini3Model()` checks for non-Google providers

### Step 12: Create barrel export

Create `packages/core/src/providers/index.ts`:

- Export all provider types and classes

### Step 13: Write unit tests

Create `packages/core/src/providers/__tests__/`:

- `type-mappers.test.ts` — ≥20 test cases:
  - Text message conversion (user, model/assistant)
  - System instruction injection
  - Function call conversion (both directions)
  - Function response conversion
  - Multi-part messages
  - Empty messages
  - Tool declaration conversion
  - Finish reason mapping (all variants)
  - Usage metadata mapping
  - Malformed input handling
- `streaming-tool-buffer.test.ts`:
  - Single tool call across 3 chunks
  - Multiple tool calls in parallel
  - Malformed JSON arguments
  - Empty tool call (name only, no args)
- `openai-compatible.test.ts`:
  - Mock OpenAI client, verify request conversion
  - Mock streaming response, verify event sequence
  - Error handling (429, 503, timeout, empty response)

### Step 14: Integration test with Ollama

- Start local Ollama with a small model (e.g., `llama3.2:1b`)
- Point `OpenAICompatibleContentGenerator` at `http://localhost:11434/v1`
- Send a text prompt, verify streaming response
- Send a prompt with tools, verify tool call flow (if model supports it)
- Record the session for CI replay

### Step 15: Live test with NVIDIA NIM

- Point at `https://integrate.api.nvidia.com/v1` with NVIDIA_API_KEY
- Model: `nvidia/nemotron-3-super-120b-a12b`
- Send text prompt, verify streaming
- Send prompt with tools, verify tool calling
- Record session, diff against OpenAI spec, encode any NIM-specific edge cases

## File Manifest

| File                                                                  | Status                           | Description                                             |
| --------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `packages/core/src/providers/type-mappers.ts`                         | CREATE                           | Gemini ↔ OpenAI format converters                      |
| `packages/core/src/providers/openai-compatible.ts`                    | CREATE                           | OpenAI ContentGenerator adapter                         |
| `packages/core/src/providers/registry.ts`                             | CREATE                           | Provider routing                                        |
| `packages/core/src/providers/capability.ts`                           | CREATE                           | Model capability probing                                |
| `packages/core/src/providers/index.ts`                                | CREATE                           | Barrel export                                           |
| `packages/core/src/telemetry/mlflow-tracer.ts`                        | CREATE                           | MLflow span tracing (degrades to JSON if no MLflow URI) |
| `packages/core/src/core/contentGenerator.ts`                          | MODIFY                           | Add provider routing at line ~271                       |
| `packages/core/src/config/config.ts`                                  | MODIFY                           | Add providerType to config                              |
| `packages/core/src/config/models.ts`                                  | MODIFY                           | Pass through non-Gemini model names                     |
| `packages/core/src/providers/__tests__/type-mappers.test.ts`          | CREATE                           | Unit tests                                              |
| `packages/core/src/providers/__tests__/streaming-tool-buffer.test.ts` | MERGED into type-mappers.test.ts | Buffer tests live alongside buffer class                |
| `packages/core/src/providers/__tests__/openai-compatible.test.ts`     | CREATE                           | Unit tests                                              |
| `packages/core/package.json`                                          | MODIFY                           | Add `openai` and `mlflow-tracing` dependencies          |

## Plan Amendments

### Amendment 1 (iteration 3)

**What changed:** `GenerateContentResponse` is a class (not interface) with
`new GenerateContentResponse()` constructor + property assignment.
`functionCalls` is a getter derived from `candidates[0].content.parts` — not a
direct property. **Why:** Verified by reading
`node_modules/@google/genai/dist/genai.d.ts` line 3042 and `dist/index.mjs`
line 2056. **Impact:** type-mappers.ts uses `new GenerateContentResponse()` and
sets `candidates` with `functionCall` parts so the getter works automatically.

### Amendment 2 (iteration 4)

**What changed:** `config.ts` and `models.ts` do NOT need modification. Provider
env var reading was added to `createContentGeneratorConfig()` in
`contentGenerator.ts`. The OpenAI provider routing returns before
`resolveModel()` is called, so non-Gemini model names are never subject to alias
resolution. **Why:** The provider routing in `createContentGenerator()` is the
first check, before any Google-specific code runs. Adding separate changes to
config.ts and models.ts would be unnecessary duplication. **Impact:** Two fewer
files modified. Cleaner change set.

### Amendment 3 (iteration 7)

**What changed:** `streaming-tool-buffer.test.ts` merged into
`type-mappers.test.ts`. The `StreamingToolCallBuffer` class lives in
`type-mappers.ts`, so its tests belong in the same test file. **Why:**
Colocation principle — tests live next to the code they test. **Impact:** One
fewer test file. 5 buffer tests are in type-mappers.test.ts (total 33 tests in
that file).
