/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI-compatible ContentGenerator adapter.
 *
 * Implements the ContentGenerator interface using any OpenAI-compatible API
 * (NVIDIA NIM, Grok/xAI, Ollama, OpenAI itself). Converts between Gemini
 * and OpenAI request/response formats so the entire agent stack works
 * transparently with any model provider.
 */

import {
  CountTokensResponse,
  FinishReason,
  GenerateContentResponse,
  type Candidate,
  type Content,
  type CountTokensParameters,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { debugLogger } from '../utils/debugLogger.js';

/** Extract HTTP status code from an error object, if present. */
function getErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    if ('status' in error && typeof error.status === 'number')
      return error.status;
    if ('statusCode' in error && typeof error.statusCode === 'number')
      return error.statusCode;
  }
  return undefined;
}

/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- ContentListUnion narrowing requires type assertions after runtime checks */
/** Extract Content[] from the union type ContentListUnion. */
function extractContents(
  contents: GenerateContentParameters['contents'],
): Content[] {
  if (!contents) return [];
  if (Array.isArray(contents)) {
    // Content[] or PartUnion[] — Content has 'role', PartUnion doesn't
    if (contents.length === 0) return [];
    const first = contents[0];
    if (typeof first === 'object' && first !== null && 'role' in first) {
      return contents as unknown as Content[];
    }
    // PartUnion[] — wrap in a single Content
    return [{ role: 'user', parts: contents as unknown as Part[] }];
  }
  // Single Content or PartUnion
  if (typeof contents === 'object' && contents !== null && 'role' in contents) {
    return [contents as unknown as Content];
  }
  return [{ role: 'user', parts: [contents as unknown as Part] }];
}
/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */
import {
  geminiContentsToOpenAIMessages,
  geminiToolsToOpenAITools,
  openAIChunkToGeminiResponse,
  openAIResponseToGeminiResponse,
  StreamingToolCallBuffer,
} from './type-mappers.js';

// ---------------------------------------------------------------------------
// Model context window resolution
// ---------------------------------------------------------------------------

/** Cache of context windows fetched from provider /models endpoints. */
const modelContextCache = new Map<string, number>();

const DEFAULT_CONTEXT_WINDOW = 131072; // 128K — conservative default

/**
 * Well-known context windows for popular models (when API doesn't report them).
 * Keyed by model ID substring match.
 */
const WELL_KNOWN_CONTEXT: Array<[pattern: string, tokens: number]> = [
  // Meta Llama
  ['llama-4', 1048576],
  ['llama-3.3', 131072],
  ['llama-3.1-405b', 131072],
  ['llama-3.1-70b', 131072],
  ['llama-3.1-8b', 131072],
  ['llama-3.2', 131072],
  ['llama3-70b', 8192],
  ['llama3-8b', 8192],
  ['llama2', 4096],
  // Qwen
  ['qwen3', 131072],
  ['qwen2.5-coder', 131072],
  ['qwen2.5', 131072],
  ['qwq', 131072],
  // DeepSeek
  ['deepseek-v3', 163840],
  ['deepseek-r1', 163840],
  ['deepseek-coder', 16384],
  // Mistral
  ['mistral-large', 131072],
  ['mistral-small', 131072],
  ['mixtral-8x22b', 65536],
  ['mixtral-8x7b', 32768],
  ['mistral-7b', 32768],
  ['codestral', 32768],
  // NVIDIA
  ['nemotron-3-super', 131072],
  ['nemotron-4-340b', 4096],
  ['nemotron-nano', 131072],
  // Google (open models)
  ['gemma-3', 131072],
  ['gemma-2', 8192],
  // Microsoft
  ['phi-4', 16384],
  ['phi-3.5', 131072],
  ['phi-3-medium-128k', 131072],
  ['phi-3-mini-128k', 131072],
  ['phi-3', 4096],
  // OpenAI
  ['gpt-4o', 128000],
  ['gpt-4-turbo', 128000],
  ['gpt-4', 8192],
  ['gpt-3.5-turbo', 16385],
  // xAI
  ['grok-3', 131072],
  ['grok-2', 131072],
  // Kimi
  ['kimi-k2', 131072],
];

/**
 * Get context window for a model. Checks:
 * 1. Cache from /models API response
 * 2. Well-known defaults table
 * 3. Conservative fallback (128K)
 */
export function getModelContextWindow(model: string): number {
  // Check API cache first
  const cached = modelContextCache.get(model);
  if (cached) return cached;

  // Check well-known patterns
  const lower = model.toLowerCase();
  for (const [pattern, tokens] of WELL_KNOWN_CONTEXT) {
    if (lower.includes(pattern)) {
      return tokens;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Set a model's context window in the cache (e.g. from settings or API).
 */
export function setModelContextWindow(model: string, tokens: number): void {
  modelContextCache.set(model, tokens);
}

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  firstTokenTimeout?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
}

export class OpenAICompatibleContentGenerator implements ContentGenerator {
  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout ?? 60000,
      defaultHeaders: config.defaultHeaders,
      maxRetries: 0, // We handle retries ourselves
    });
  }

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const messages = geminiContentsToOpenAIMessages(
      extractContents(request.contents),
      typeof request.config?.systemInstruction === 'string'
        ? request.config.systemInstruction
        : undefined,
    );
    const tools = geminiToolsToOpenAITools(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ToolUnion[] → Tool[] (only using functionDeclarations)
      request.config?.tools as
        | Array<{
            functionDeclarations?: Array<
              import('@google/genai').FunctionDeclaration
            >;
          }>
        | undefined,
    );

    const completionParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: request.model ?? this.config.model,
      messages,
      stream: false,
      ...(tools && { tools }),
    };

    const response = await this.callWithRetry(() =>
      this.client.chat.completions.create(completionParams),
    );

    return openAIResponseToGeminiResponse(response);
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const messages = geminiContentsToOpenAIMessages(
      extractContents(request.contents),
      typeof request.config?.systemInstruction === 'string'
        ? request.config.systemInstruction
        : undefined,
    );
    const tools = geminiToolsToOpenAITools(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ToolUnion[] → Tool[] (only using functionDeclarations)
      request.config?.tools as
        | Array<{
            functionDeclarations?: Array<
              import('@google/genai').FunctionDeclaration
            >;
          }>
        | undefined,
    );

    const completionParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: request.model ?? this.config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && { tools }),
    };

    const callWithRetry = this.callWithRetry.bind(this);
    const client = this.client;
    const firstTokenTimeout = this.config.firstTokenTimeout;

    async function* streamGenerator(): AsyncGenerator<GenerateContentResponse> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenAI streaming returns AsyncIterable
      const stream = (await callWithRetry(() =>
        client.chat.completions.create(completionParams),
      )) as unknown as AsyncIterable<ChatCompletionChunk>;

      const toolBuffer = new StreamingToolCallBuffer();
      let hasYielded = false;
      let firstTokenReceived = false;

      // Set up first token timeout warning
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (firstTokenTimeout) {
        timeoutId = setTimeout(() => {
          if (!firstTokenReceived) {
            debugLogger.warn(
              `[OpenAI Provider] First token timeout (${firstTokenTimeout}ms) exceeded for model ${completionParams.model}`,
            );
          }
        }, firstTokenTimeout);
      }

      try {
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];

          // Clear timeout on first meaningful token
          if (
            !firstTokenReceived &&
            (choice?.delta?.content || choice?.delta?.tool_calls)
          ) {
            firstTokenReceived = true;
            if (timeoutId) {
              clearTimeout(timeoutId);
              timeoutId = undefined;
            }
          }

          // Accumulate tool call deltas
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              toolBuffer.accumulate(tc);
            }
          }

          // On finish_reason, flush buffered tool calls
          if (choice?.finish_reason && toolBuffer.hasBuffered()) {
            const { calls, errors } = toolBuffer.flush();
            if (errors.length > 0) {
              // Yield error info but don't crash
              debugLogger.warn(
                '[OpenAI Provider] Tool call parse errors:',
                errors,
              );
            }
            const response = openAIChunkToGeminiResponse(chunk, calls);
            yield response;
            hasYielded = true;
            continue;
          }

          // Text content or finish without tool calls
          if (choice?.delta?.content || choice?.finish_reason) {
            const response = openAIChunkToGeminiResponse(chunk);
            yield response;
            hasYielded = true;
            continue;
          }

          // Usage-only chunk (final chunk with stream_options)
          if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
            const response = openAIChunkToGeminiResponse(chunk);
            yield response;
            hasYielded = true;
          }
        }

        // If nothing was yielded, emit an empty response
        if (!hasYielded) {
          const empty = new GenerateContentResponse();
          const emptyCandidate: Candidate = {
            content: { role: 'model', parts: [] as Part[] },
            finishReason: FinishReason.STOP,
          };
          empty.candidates = [emptyCandidate];
          yield empty;
        }
      } catch (error: unknown) {
        // Yield what we have so far as an error event
        const errMessage =
          error instanceof Error ? error.message : 'Unknown error';
        const errResponse = new GenerateContentResponse();
        const errCandidate: Candidate = {
          content: {
            role: 'model',
            parts: [
              {
                text: `Error from provider: ${errMessage}`,
              },
            ],
          },
          finishReason: FinishReason.STOP,
        };
        errResponse.candidates = [errCandidate];
        yield errResponse;
      } finally {
        // Clean up timeout if still pending
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    return streamGenerator();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // OpenAI-compatible APIs typically don't have a dedicated token counting
    // endpoint. Estimate using content-aware heuristics.
    let totalTokens = 0;
    for (const content of extractContents(request.contents)) {
      for (const part of content.parts ?? []) {
        if (part.text) {
          totalTokens += this.estimateTokenCount(part.text);
        }
      }
    }

    const tokenResponse = new CountTokensResponse();
    tokenResponse.totalTokens = totalTokens;
    return tokenResponse;
  }

  /**
   * Estimate token count for text content.
   *
   * Uses heuristics based on content type:
   * - Plain ASCII text: ~4 characters per token
   * - Code (brackets, operators): ~3 characters per token
   * - Non-ASCII (Unicode, CJK): ~2.5 characters per token
   *
   * For accurate counts, providers should implement native token counting.
   */
  private estimateTokenCount(text: string): number {
    if (!text) return 0;

    // Check for non-ASCII characters (Unicode, CJK, etc.)
    // Using Unicode property escapes to avoid control character regex issues
    const nonAsciiCount = (text.match(/\P{ASCII}/gu) ?? []).length;
    const isMostlyNonAscii = nonAsciiCount > text.length * 0.3;

    // Check for code-like patterns (brackets, operators)
    const codePatternCount = (text.match(/[{}[\]();=<>]/g) ?? []).length;
    const isCodeLike = codePatternCount > text.length * 0.05;

    let divisor: number;
    if (isMostlyNonAscii) {
      divisor = 2.5; // Non-ASCII uses more tokens per character
    } else if (isCodeLike) {
      divisor = 3; // Code uses more tokens per character
    } else {
      divisor = 4; // Plain text estimate
    }

    return Math.ceil(text.length / divisor);
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    const reqRecord = request as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- accessing optional 'content' field
    const content = reqRecord['content'] ?? request.contents;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (content && typeof content === 'object' && 'parts' in content) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-checked 'parts' property
      const contentObj = content as unknown as Content;
      text =
        contentObj.parts
          ?.filter((p: Part) => p.text)
          .map((p: Part) => p.text)
          .join('\n') ?? '';
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: text,
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- constructing compatible response shape
      return {
        embedding: {
          values: response.data[0]?.embedding ?? [],
        },
      } as EmbedContentResponse;
    } catch {
      // If embedding endpoint not available, return empty
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- constructing compatible response shape
      return {
        embedding: { values: [] },
      } as EmbedContentResponse;
    }
  }

  // -------------------------------------------------------------------------
  // Model listing
  // -------------------------------------------------------------------------

  /**
   * List available models from the provider's /models endpoint.
   * Returns model IDs sorted alphabetically.
   */
  async listModels(): Promise<string[]> {
    try {
      const response = await this.client.models.list();
      const models: string[] = [];
      for await (const model of response) {
        models.push(model.id);
        // Cache context length from metadata if available
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing provider-specific metadata field
        const meta = (model as unknown as Record<string, unknown>)['metadata'];
        if (meta && typeof meta === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- runtime-checked object
          const metaRecord = meta as Record<string, unknown>;
          const ctxLen = metaRecord['context_length'];
          if (typeof ctxLen === 'number') {
            modelContextCache.set(model.id, ctxLen);
          }
        }
      }
      return models.sort();
    } catch {
      // If /models endpoint not available, return empty
      return [];
    }
  }

  /**
   * Get the context window size for a model.
   * Checks: cached API response → well-known defaults → fallback.
   */
  getModelContextWindow(model: string): number {
    return getModelContextWindow(model);
  }

  // -------------------------------------------------------------------------
  // Retry logic
  // -------------------------------------------------------------------------

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxAttempts = this.config.retryAttempts ?? 3;
    const baseBackoff = this.config.retryBackoffMs ?? 1000;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const status = getErrorStatus(error);

        // Don't retry auth errors
        if (status === 401 || status === 403) {
          throw error;
        }

        // Retry on rate limit or server errors
        if (
          (status === 429 || status === 502 || status === 503) &&
          attempt < maxAttempts - 1
        ) {
          const delay = baseBackoff * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    // Should not reach here, but TypeScript needs it
    const provider = this.config.baseUrl;
    const model = this.config.model;
    const lastErrorStr = lastError?.message ?? 'Unknown error';
    throw new Error(
      `${provider} (${model}): ${lastErrorStr}. ` +
        `All ${maxAttempts} retry attempts exhausted. ` +
        `Try again in a minute or check your configuration.`,
    );
  }
}
