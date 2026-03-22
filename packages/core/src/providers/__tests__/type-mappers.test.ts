/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  geminiContentsToOpenAIMessages,
  geminiToolsToOpenAITools,
  openAIChunkToGeminiResponse,
  openAIResponseToGeminiResponse,
  openAIFinishReasonToGemini,
  validateGeminiResponse,
  StreamingToolCallBuffer,
} from '../type-mappers.js';
import { GenerateContentResponse, type Content } from '@google/genai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';

// ---------------------------------------------------------------------------
// geminiContentsToOpenAIMessages
// ---------------------------------------------------------------------------

describe('geminiContentsToOpenAIMessages', () => {
  it('converts user text message', () => {
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Hello' }] }];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('converts model text message to assistant', () => {
    const contents: Content[] = [
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages).toEqual([{ role: 'assistant', content: 'Hi there' }]);
  });

  it('injects system instruction as first message', () => {
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'Hello' }] }];
    const messages = geminiContentsToOpenAIMessages(
      contents,
      'You are helpful',
    );
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('converts function call parts to tool_calls', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_123',
              name: 'read_file',
              args: { path: '/tmp/test' },
            },
          },
        ],
      },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"/tmp/test"}',
          },
        },
      ],
    });
  });

  it('converts function response parts to tool messages', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_123',
              name: 'read_file',
              response: { output: 'file contents' },
            },
          },
        ],
      },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_123',
      content: '{"output":"file contents"}',
    });
  });

  it('joins multi-part text with newlines', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'Part 1' }, { text: 'Part 2' }],
      },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages[0]).toEqual({ role: 'user', content: 'Part 1\nPart 2' });
  });

  it('handles empty parts', () => {
    const contents: Content[] = [{ role: 'user', parts: [] }];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages).toEqual([{ role: 'user', content: '' }]);
  });

  it('handles multiple function responses in one content', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'tool_a',
              response: { result: 'a' },
            },
          },
          {
            functionResponse: {
              id: 'call_2',
              name: 'tool_b',
              response: { result: 'b' },
            },
          },
        ],
      },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
  });

  it('handles assistant message with text and tool_calls', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          { text: 'Let me check that.' },
          {
            functionCall: {
              id: 'call_1',
              name: 'search',
              args: { q: 'test' },
            },
          },
        ],
      },
    ];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Let me check that.',
      tool_calls: [{ id: 'call_1' }],
    });
  });

  it('handles content with no parts', () => {
    const contents: Content[] = [{ role: 'user' }];
    const messages = geminiContentsToOpenAIMessages(contents);
    expect(messages).toEqual([{ role: 'user', content: '' }]);
  });
});

// ---------------------------------------------------------------------------
// geminiToolsToOpenAITools
// ---------------------------------------------------------------------------

describe('geminiToolsToOpenAITools', () => {
  it('converts tool declarations', () => {
    const tools: Array<{
      functionDeclarations?: Array<import('@google/genai').FunctionDeclaration>;
    }> = [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather for a location',
            parameters: {
              type: 'object' as unknown as import('@google/genai').Type,
              properties: {
                location: {
                  type: 'string' as unknown as import('@google/genai').Type,
                },
              },
              required: ['location'],
            },
          },
        ],
      },
    ];
    const result = geminiToolsToOpenAITools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      },
    ]);
  });

  it('returns undefined for empty tools', () => {
    expect(geminiToolsToOpenAITools([])).toBeUndefined();
    expect(geminiToolsToOpenAITools(undefined)).toBeUndefined();
  });

  it('handles multiple function declarations', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'fn1', description: 'First' },
          { name: 'fn2', description: 'Second' },
        ],
      },
    ];
    const result = geminiToolsToOpenAITools(tools);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// openAIFinishReasonToGemini
// ---------------------------------------------------------------------------

describe('openAIFinishReasonToGemini', () => {
  it('maps stop to STOP', () => {
    expect(openAIFinishReasonToGemini('stop')).toBe('STOP');
  });

  it('maps tool_calls to STOP', () => {
    expect(openAIFinishReasonToGemini('tool_calls')).toBe('STOP');
  });

  it('maps length to MAX_TOKENS', () => {
    expect(openAIFinishReasonToGemini('length')).toBe('MAX_TOKENS');
  });

  it('maps content_filter to SAFETY', () => {
    expect(openAIFinishReasonToGemini('content_filter')).toBe('SAFETY');
  });

  it('returns undefined for null', () => {
    expect(openAIFinishReasonToGemini(null)).toBeUndefined();
  });

  it('returns STOP for unknown reasons', () => {
    expect(openAIFinishReasonToGemini('unknown')).toBe('STOP');
  });
});

// ---------------------------------------------------------------------------
// openAIChunkToGeminiResponse
// ---------------------------------------------------------------------------

describe('openAIChunkToGeminiResponse', () => {
  it('converts text chunk', () => {
    const chunk = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          delta: { content: 'Hello' },
          finish_reason: null,
        },
      ],
    } as unknown as ChatCompletionChunk;

    const response = openAIChunkToGeminiResponse(chunk);
    expect(response.responseId).toBe('chatcmpl-123');
    expect(response.modelVersion).toBe('gpt-4');
    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('Hello');
  });

  it('converts chunk with flushed tool calls', () => {
    const chunk = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        },
      ],
    } as unknown as ChatCompletionChunk;

    const toolCalls = [{ id: 'call_1', name: 'search', args: { q: 'test' } }];

    const response = openAIChunkToGeminiResponse(chunk, toolCalls);
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall).toEqual({
      id: 'call_1',
      name: 'search',
      args: { q: 'test' },
    });
  });

  it('includes usage metadata when present', () => {
    const chunk = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    } as unknown as ChatCompletionChunk;

    const response = openAIChunkToGeminiResponse(chunk);
    expect(response.usageMetadata).toMatchObject({
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    });
  });

  it('sets finish reason', () => {
    const chunk = {
      id: 'chatcmpl-123',
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    } as unknown as ChatCompletionChunk;

    const response = openAIChunkToGeminiResponse(chunk);
    expect(response.candidates?.[0]?.finishReason).toBe('STOP');
  });
});

// ---------------------------------------------------------------------------
// openAIResponseToGeminiResponse
// ---------------------------------------------------------------------------

describe('openAIResponseToGeminiResponse', () => {
  it('converts non-streaming response with text', () => {
    const response = {
      id: 'chatcmpl-456',
      model: 'gpt-4',
      choices: [
        {
          message: { content: 'Hello world', role: 'assistant' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    } as unknown as ChatCompletion;

    const gcr = openAIResponseToGeminiResponse(response);
    expect(gcr.responseId).toBe('chatcmpl-456');
    expect(gcr.candidates?.[0]?.content?.parts?.[0]?.text).toBe('Hello world');
    expect(gcr.candidates?.[0]?.finishReason).toBe('STOP');
    expect(gcr.usageMetadata).toMatchObject({
      promptTokenCount: 5,
      candidatesTokenCount: 2,
    });
  });

  it('converts response with tool calls', () => {
    const response = {
      id: 'chatcmpl-789',
      model: 'gpt-4',
      choices: [
        {
          message: {
            content: null,
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    } as unknown as ChatCompletion;

    const gcr = openAIResponseToGeminiResponse(response);
    const parts = gcr.candidates?.[0]?.content?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall).toEqual({
      id: 'call_abc',
      name: 'get_weather',
      args: { location: 'NYC' },
    });
  });

  it('handles malformed JSON in tool call arguments', () => {
    const response = {
      id: 'chatcmpl-bad',
      model: 'gpt-4',
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: {
                  name: 'test',
                  arguments: '{invalid json',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    } as unknown as ChatCompletion;

    // Should not throw
    const gcr = openAIResponseToGeminiResponse(response);
    const fc = gcr.candidates?.[0]?.content?.parts?.[0]?.functionCall;
    expect(fc?.args).toEqual({}); // Empty args on parse failure
  });
});

// ---------------------------------------------------------------------------
// validateGeminiResponse
// ---------------------------------------------------------------------------

describe('validateGeminiResponse', () => {
  it('passes for valid response', () => {
    const resp = new GenerateContentResponse();
    resp.candidates = [{ content: { role: 'model', parts: [{ text: 'hi' }] } }];
    expect(validateGeminiResponse(resp)).toEqual([]);
  });

  it('reports missing candidates', () => {
    const resp = new GenerateContentResponse();
    const issues = validateGeminiResponse(resp);
    expect(issues).toContain('Missing candidates array');
  });
});

// ---------------------------------------------------------------------------
// StreamingToolCallBuffer
// ---------------------------------------------------------------------------

describe('StreamingToolCallBuffer', () => {
  it('accumulates and flushes a single tool call', () => {
    const buffer = new StreamingToolCallBuffer();

    buffer.accumulate({
      index: 0,
      id: 'call_1',
      function: { name: 'search', arguments: '{"q":' },
      type: 'function',
    });
    buffer.accumulate({
      index: 0,
      function: { arguments: '"hello"}' },
    } as unknown as ChatCompletionChunk.Choice.Delta.ToolCall);

    expect(buffer.hasBuffered()).toBe(true);
    const { calls, errors } = buffer.flush();
    expect(errors).toHaveLength(0);
    expect(calls).toEqual([
      { id: 'call_1', name: 'search', args: { q: 'hello' } },
    ]);
    expect(buffer.hasBuffered()).toBe(false);
  });

  it('handles multiple parallel tool calls', () => {
    const buffer = new StreamingToolCallBuffer();

    buffer.accumulate({
      index: 0,
      id: 'call_1',
      function: { name: 'fn1', arguments: '{}' },
      type: 'function',
    });
    buffer.accumulate({
      index: 1,
      id: 'call_2',
      function: { name: 'fn2', arguments: '{}' },
      type: 'function',
    });

    const { calls } = buffer.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('fn1');
    expect(calls[1].name).toBe('fn2');
  });

  it('reports malformed JSON arguments without crashing', () => {
    const buffer = new StreamingToolCallBuffer();

    buffer.accumulate({
      index: 0,
      id: 'call_bad',
      function: { name: 'test', arguments: '{bad json' },
      type: 'function',
    });

    const { calls, errors } = buffer.flush();
    expect(errors).toHaveLength(1);
    expect(calls[0].args).toEqual({}); // Empty args on failure
  });

  it('handles empty arguments', () => {
    const buffer = new StreamingToolCallBuffer();

    buffer.accumulate({
      index: 0,
      id: 'call_empty',
      function: { name: 'no_args' },
      type: 'function',
    });

    const { calls, errors } = buffer.flush();
    expect(errors).toHaveLength(0);
    expect(calls[0].args).toEqual({});
  });

  it('reset clears the buffer', () => {
    const buffer = new StreamingToolCallBuffer();
    buffer.accumulate({
      index: 0,
      id: 'call_1',
      function: { name: 'fn', arguments: '{}' },
      type: 'function',
    });
    buffer.reset();
    expect(buffer.hasBuffered()).toBe(false);
  });
});
