/**
 * @license
 * Copyright 2025 Google LLC
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

    async function* streamGenerator(): AsyncGenerator<GenerateContentResponse> {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenAI streaming returns AsyncIterable
      const stream = (await callWithRetry(() =>
        client.chat.completions.create(completionParams),
      )) as unknown as AsyncIterable<ChatCompletionChunk>;

      const toolBuffer = new StreamingToolCallBuffer();
      let hasYielded = false;

      try {
        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];

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
      }
    }

    return streamGenerator();
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    // OpenAI-compatible APIs typically don't have a dedicated token counting
    // endpoint. Estimate based on character count / 4.
    let charCount = 0;
    for (const content of extractContents(request.contents)) {
      for (const part of content.parts ?? []) {
        if (part.text) charCount += part.text.length;
      }
    }
    const estimatedTokens = Math.ceil(charCount / 4);

    const tokenResponse = new CountTokensResponse();
    tokenResponse.totalTokens = estimatedTokens;
    return tokenResponse;
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
  // Retry logic
  // -------------------------------------------------------------------------

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const maxAttempts = this.config.retryAttempts ?? 3;
    const baseBackoff = this.config.retryBackoffMs ?? 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
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
    throw new Error("I'm temporarily unavailable. Try again in a minute.");
  }
}
