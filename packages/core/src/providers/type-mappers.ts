/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bidirectional type mappers between Gemini (@google/genai) and OpenAI formats.
 *
 * Request flow:  Gemini Content[] → OpenAI messages[]
 * Response flow: OpenAI ChatCompletionChunk → Gemini GenerateContentResponse
 */

import {
  FinishReason,
  GenerateContentResponse,
  type Candidate,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from '@google/genai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// Request conversion: Gemini → OpenAI
// ---------------------------------------------------------------------------

/**
 * Convert Gemini Content[] + system instruction to OpenAI messages[].
 */
export function geminiContentsToOpenAIMessages(
  contents: Content[],
  systemInstruction?: string,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction });
  }

  for (const content of contents) {
    const role =
      content.role === 'model' ? 'assistant' : (content.role ?? 'user');

    if (!content.parts || content.parts.length === 0) {
      if (role === 'user' || role === 'assistant') {
        messages.push({ role, content: '' } as ChatCompletionMessageParam);
      }
      continue;
    }

    // Check if all parts are function responses — these become tool messages
    if (content.parts.every((p) => p.functionResponse)) {
      for (const part of content.parts) {
        const fr = part.functionResponse!;
        messages.push({
          role: 'tool' as const,
          tool_call_id: fr.id ?? fr.name ?? '',
          content: JSON.stringify(fr.response ?? {}),
        });
      }
      continue;
    }

    // Check if any parts have functionCall — assistant message with tool_calls
    const functionCallParts = content.parts.filter((p) => p.functionCall);
    if (functionCallParts.length > 0 && role === 'assistant') {
      const textParts = content.parts.filter((p) => p.text);
      const textContent = textParts.map((p) => p.text).join('\n') || null;
      messages.push({
        role: 'assistant',
        content: textContent,
        tool_calls: functionCallParts.map((p) => ({
          id: p.functionCall!.id ?? p.functionCall!.name ?? '',
          type: 'function' as const,
          function: {
            name: p.functionCall!.name ?? '',
            arguments: JSON.stringify(p.functionCall!.args ?? {}),
          },
        })),
      });
      continue;
    }

    // Regular text message — join all text parts
    if (role === 'user' || role === 'assistant') {
      const text = content.parts
        .filter((p) => p.text !== undefined)
        .map((p) => p.text)
        .join('\n');
      messages.push({ role, content: text } as ChatCompletionMessageParam);
    }
  }

  return messages;
}

/**
 * Convert Gemini tool declarations to OpenAI tool format.
 */
export function geminiToolsToOpenAITools(
  tools?: Array<{ functionDeclarations?: FunctionDeclaration[] }>,
): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const openAITools: ChatCompletionTool[] = [];
  for (const tool of tools) {
    if (!tool.functionDeclarations) continue;
    for (const fn of tool.functionDeclarations) {
      openAITools.push({
        type: 'function',
        function: {
          name: fn.name ?? '',
          description: fn.description,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Schema → JSON schema object for OpenAI
          parameters: fn.parameters as Record<string, unknown> | undefined,
        },
      });
    }
  }

  return openAITools.length > 0 ? openAITools : undefined;
}

// ---------------------------------------------------------------------------
// Response conversion: OpenAI → Gemini
// ---------------------------------------------------------------------------

/**
 * Map OpenAI finish_reason to Gemini FinishReason string.
 */
export function openAIFinishReasonToGemini(
  reason: string | null | undefined,
): FinishReason | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'stop':
      return FinishReason.STOP;
    case 'tool_calls':
      return FinishReason.STOP; // Gemini doesn't distinguish
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'content_filter':
      return FinishReason.SAFETY;
    default:
      return FinishReason.STOP;
  }
}

/**
 * Convert an OpenAI streaming chunk to a GenerateContentResponse.
 * For tool call chunks, pass the flushed tool calls from the buffer.
 */
export function openAIChunkToGeminiResponse(
  chunk: ChatCompletionChunk,
  flushedToolCalls?: FunctionCall[],
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  response.responseId = chunk.id;
  response.modelVersion = chunk.model;

  const choice = chunk.choices?.[0];
  const parts: Part[] = [];

  // Text content
  if (choice?.delta?.content) {
    parts.push({ text: choice.delta.content, thought: false });
  }

  // Tool calls from buffer flush
  if (flushedToolCalls && flushedToolCalls.length > 0) {
    for (const tc of flushedToolCalls) {
      parts.push({ functionCall: tc });
    }
  }

  const finishReason = openAIFinishReasonToGemini(choice?.finish_reason);

  const candidate: Candidate = {
    content: { role: 'model', parts },
    finishReason,
  };
  response.candidates = [candidate];

  // Usage metadata (typically only in final chunk with stream_options)
  if (chunk.usage) {
    const usageMeta: GenerateContentResponseUsageMetadata = {
      promptTokenCount: chunk.usage.prompt_tokens,
      candidatesTokenCount: chunk.usage.completion_tokens,
      totalTokenCount: chunk.usage.total_tokens,
    };
    response.usageMetadata = usageMeta;
  }

  return response;
}

/**
 * Convert a non-streaming OpenAI ChatCompletion to GenerateContentResponse.
 */
export function openAIResponseToGeminiResponse(
  response: ChatCompletion,
): GenerateContentResponse {
  const gcr = new GenerateContentResponse();
  gcr.responseId = response.id;
  gcr.modelVersion = response.model;

  const choice = response.choices?.[0];
  const message = choice?.message;
  const parts: Part[] = [];

  if (message?.content) {
    parts.push({ text: message.content, thought: false });
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      if (!('function' in tc)) continue; // skip custom tool calls
      let args: Record<string, unknown> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse result typed as args object
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Malformed JSON — pass empty args
      }
      parts.push({
        functionCall: {
          id: tc.id,
          name: tc.function.name,
          args,
        },
      });
    }
  }

  const candidate: Candidate = {
    content: { role: 'model', parts },
    finishReason: openAIFinishReasonToGemini(choice?.finish_reason),
  };
  gcr.candidates = [candidate];

  if (response.usage) {
    const usageMeta: GenerateContentResponseUsageMetadata = {
      promptTokenCount: response.usage.prompt_tokens,
      candidatesTokenCount: response.usage.completion_tokens,
      totalTokenCount: response.usage.total_tokens,
    };
    gcr.usageMetadata = usageMeta;
  }

  return gcr;
}

// ---------------------------------------------------------------------------
// Streaming Tool Call Buffer
// ---------------------------------------------------------------------------

interface BufferedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Buffers incremental tool call deltas from OpenAI streaming and flushes
 * complete FunctionCall[] when the finish_reason arrives.
 */
export class StreamingToolCallBuffer {
  private buffer: Map<number, BufferedToolCall> = new Map();

  /**
   * Accumulate a tool call delta by its index.
   */
  accumulate(delta: ChatCompletionChunk.Choice.Delta.ToolCall): void {
    const existing = this.buffer.get(delta.index);
    if (existing) {
      // Append arguments fragment
      if (delta.function?.arguments) {
        existing.arguments += delta.function.arguments;
      }
      // Update name if provided (shouldn't happen after first chunk, but be safe)
      if (delta.function?.name) {
        existing.name = delta.function.name;
      }
    } else {
      // New tool call entry
      this.buffer.set(delta.index, {
        id: delta.id ?? '',
        name: delta.function?.name ?? '',
        arguments: delta.function?.arguments ?? '',
      });
    }
  }

  /**
   * Returns true if there are buffered tool calls.
   */
  hasBuffered(): boolean {
    return this.buffer.size > 0;
  }

  /**
   * Flush all buffered tool calls as FunctionCall[].
   * Parses JSON arguments; returns empty args on parse failure.
   * Clears the buffer.
   */
  flush(): { calls: FunctionCall[]; errors: string[] } {
    const calls: FunctionCall[] = [];
    const errors: string[] = [];

    for (const [, tc] of this.buffer) {
      let args: Record<string, unknown> = {};
      try {
        if (tc.arguments) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse result typed as args object
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        }
      } catch (_e) {
        errors.push(
          `Failed to parse tool call arguments for "${tc.name}": ${tc.arguments}`,
        );
      }
      calls.push({
        id: tc.id,
        name: tc.name,
        args,
      });
    }

    this.buffer.clear();
    return { calls, errors };
  }

  /**
   * Reset the buffer without flushing.
   */
  reset(): void {
    this.buffer.clear();
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Assert that a constructed GenerateContentResponse has the minimum fields
 * required by Turn.ts and LoggingContentGenerator.
 */
export function validateGeminiResponse(
  response: GenerateContentResponse,
): string[] {
  const issues: string[] = [];

  if (!response.candidates || response.candidates.length === 0) {
    issues.push('Missing candidates array');
  } else {
    const candidate = response.candidates[0];
    if (!candidate.content) {
      issues.push('Missing candidates[0].content');
    } else if (!candidate.content.parts) {
      issues.push('Missing candidates[0].content.parts');
    }
  }

  return issues;
}
