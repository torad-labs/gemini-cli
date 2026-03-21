# OpenAI Provider — Acceptance Criteria

## Phase 1 is DONE when ALL of the following are true:

### Core Adapter

- [ ] `OpenAICompatibleContentGenerator` implements all 4 `ContentGenerator`
      methods
- [ ] `generateContentStream()` yields valid `GenerateContentResponse` objects
      that pass through `Turn.run()` without errors
- [ ] `generateContent()` returns a valid `GenerateContentResponse` for
      non-streaming use
- [ ] `countTokens()` returns a `CountTokensResponse` (real endpoint or
      estimation)
- [ ] `embedContent()` returns an `EmbedContentResponse` (real endpoint or stub
      with clear error)
- [ ] Response objects pass through `LoggingContentGenerator` without errors
      (all accessed fields present)

### Type Mapping

- [ ] `geminiContentsToOpenAIMessages()` correctly converts all Content types:
      text, functionCall, functionResponse
- [ ] `geminiToolsToOpenAITools()` correctly converts tool declarations with
      name, description, parameters
- [ ] `openAIChunkToGeminiResponse()` produces responses with:
      `candidates[0].content.parts[]`, `functionCalls[]`, `finishReason`,
      `usageMetadata`, `responseId`
- [ ] System instruction injected as first message with `role: "system"`
- [ ] `part.thought` always set to `false` (OpenAI doesn't have thinking parts)
- [ ] Multi-part Gemini messages joined with newlines for OpenAI, single part on
      the way back

### Streaming Tool Calls

- [ ] `StreamingToolCallBuffer` correctly accumulates incremental tool call
      chunks by index
- [ ] Multiple parallel tool calls buffered and flushed together
- [ ] `JSON.parse` failure on tool call arguments caught — yields error event,
      doesn't crash
- [ ] Complete `functionCalls[]` array yielded only after `finish_reason`
      arrives
- [ ] Tool call IDs preserved through the round-trip (call ID from model → tool
      result → next request)

### Error Handling

- [ ] 429 responses trigger retry with exponential backoff (1s, 2s, 4s), max 3
      attempts
- [ ] 502/503 responses trigger retry with same backoff
- [ ] 401/403 responses yield error event immediately (no retry)
- [ ] Request timeout yields error event: descriptive message, not stack trace
- [ ] Empty response (no text, no tools, no finish reason) detected — yields
      `Finished` with `EMPTY_RESPONSE`
- [ ] Malformed streaming chunk doesn't crash the generator — yields error event
      and continues
- [ ] All retries exhausted yields user-friendly error: "I'm temporarily
      unavailable"

### Provider Registry

- [ ] `ProviderRegistry.create()` routes to `OpenAICompatibleContentGenerator`
      for `type: 'openai-compatible'`
- [ ] `ProviderRegistry.create()` routes to existing Google GenAI path for
      `type: 'google-genai'`
- [ ] Unknown provider type yields clear error

### Config Integration

- [ ] `providerType` field added to `ContentGeneratorConfig`
- [ ] `openaiConfig` with baseUrl, model, timeout, retryAttempts accepted
- [ ] Environment variables `PROVIDER_TYPE`, `OPENAI_BASE_URL`,
      `OPENAI_API_KEY`, `OPENAI_MODEL` work
- [ ] Default behavior unchanged — existing Gemini CLI works exactly as before
      without any env vars set

### Model Resolution

- [ ] `resolveModel()` passes through non-Gemini model names without error
- [ ] Gemini aliases (`auto`, `pro`, `flash`) still work for Google provider
- [ ] Non-Gemini model names don't trigger `isPreviewModel()` or
      `isGemini3Model()` checks

### Observability (MLflow Tracing)

- [ ] `mlflow-tracing` package installed and initialized when
      `MLFLOW_TRACKING_URI` is set
- [ ] `SpanType.AGENT` span wraps session lifecycle with sessionId + agentId
      attributes
- [ ] `SpanType.CHAIN` span wraps each turn with turnId attribute
- [ ] `SpanType.LLM` span wraps each provider call with attributes: model,
      provider, baseUrl, promptTokens, completionTokens, latencyMs, finishReason
- [ ] `SpanType.TOOL` span wraps each tool execution with attributes: toolName,
      callId, status, durationMs
- [ ] Spans nest correctly: AGENT → CHAIN → LLM / TOOL
- [ ] Spans visible in MLflow UI under configured experiment
- [ ] No duplicate spans (no `experimental_telemetry` inside `withSpan`, no OTLP
      dual-export)
- [ ] Graceful degradation: `MLFLOW_TRACKING_URI` not set → falls back to JSON
      stdout logging, no crash, no noise
- [ ] Error events recorded as span attributes with structured error info

### Tests

- [ ] ≥20 unit tests for type-mappers covering all conversion paths and edge
      cases
- [ ] Streaming tool call buffer tests: single tool, multi-tool, malformed JSON,
      empty args
- [ ] OpenAI adapter tests with mocked client: request conversion, streaming
      events, error paths
- [ ] All tests pass: `npm test -w packages/core`

### Integration

- [ ] TypeScript compiles clean: `npx tsc --noEmit` passes with zero errors
- [ ] Existing Gemini CLI unchanged: `npx gemini --help` works, basic Gemini
      conversation works
- [ ] Integration test against local Ollama passes (text + tool calling if model
      supports it)
- [ ] Live test against NVIDIA NIM with Nemotron passes (text + tool calling)

### Backward Compatibility

- [ ] No changes to `turn.ts`, `geminiChat.ts`, `client.ts` (zero diff)
- [ ] No changes to SDK layer (`packages/sdk/`)
- [ ] No changes to tool registry or MCP
- [ ] No changes to session persistence
- [ ] `LoggingContentGenerator` works identically with new provider (verified by
      reading its field access)

---

## COMPLETION GATE

**You CANNOT report this feature as complete without doing the following:**

1. Re-read every file in the File Manifest (from openai-provider.md)
2. For each file, diff what was built against what the plan specified
3. For each acceptance criterion above, verify it with evidence (test output,
   compile output, or code read)
4. If ANY criterion is unchecked, it is a gap — go back to Phase 4

**The completion message MUST include:**

```
PLAN vs IMPLEMENTATION DIFF:
  [For each file: what the plan said → what was actually built → MATCH/DIVERGE]

ACCEPTANCE CRITERIA: N/N passed
  [List each with evidence]
```

If you cannot produce this diff, you are not done.
