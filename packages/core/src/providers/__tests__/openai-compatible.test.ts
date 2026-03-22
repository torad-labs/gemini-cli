/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleContentGenerator } from '../openai-compatible.js';
import { geminiContentsToOpenAIMessages } from '../type-mappers.js';
import type { GenerateContentParameters } from '@google/genai';
import { LlmRole } from '../../telemetry/llmRole.js';

// Mock OpenAI client
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: vi.fn(),
      },
    };
    embeddings = {
      create: vi.fn(),
    };

    constructor(_config: Record<string, unknown>) {}
  },
}));

function createGenerator() {
  return new OpenAICompatibleContentGenerator({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model',
  });
}

function makeRequest(text: string): GenerateContentParameters {
  return {
    model: 'test-model',
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      systemInstruction: 'You are helpful.',
    },
  };
}

describe('OpenAICompatibleContentGenerator', () => {
  it('creates without error', () => {
    const generator = createGenerator();
    expect(generator).toBeDefined();
  });

  it('implements countTokens with estimation', async () => {
    const generator = createGenerator();
    const result = await generator.countTokens({
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
    });
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('estimates more tokens for code-like content', async () => {
    const generator = createGenerator();
    // Plain text: "Hello world" should use ~4 chars/token
    const plainResult = await generator.countTokens({
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
    });

    // Code: "function test() { return 1; }" should use ~3 chars/token
    const codeResult = await generator.countTokens({
      model: 'test-model',
      contents: [
        { role: 'user', parts: [{ text: 'function test() { return 1; }' }] },
      ],
    });

    // Code should estimate more tokens per character
    const plainTokens = plainResult.totalTokens ?? 0;
    const codeTokens = codeResult.totalTokens ?? 0;
    const plainRatio = plainTokens / 11; // "Hello world" length
    const codeRatio = codeTokens / 27; // code string length
    expect(codeRatio).toBeGreaterThanOrEqual(plainRatio);
  });

  it('estimates more tokens for non-ASCII content', async () => {
    const generator = createGenerator();
    // ASCII text
    const asciiResult = await generator.countTokens({
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
    });

    // Non-ASCII (Chinese) - should use ~2.5 chars/token
    const unicodeResult = await generator.countTokens({
      model: 'test-model',
      contents: [
        { role: 'user', parts: [{ text: '你好世界你好世界你好世界' }] },
      ],
    });

    // Unicode should estimate more tokens per character
    const asciiTokens = asciiResult.totalTokens ?? 0;
    const unicodeTokens = unicodeResult.totalTokens ?? 0;
    const asciiRatio = asciiTokens / 11;
    const unicodeRatio = unicodeTokens / 15;
    expect(unicodeRatio).toBeGreaterThanOrEqual(asciiRatio);
  });

  it('constructs correct OpenAI messages from Gemini request', () => {
    const messages = geminiContentsToOpenAIMessages(
      [{ role: 'user', parts: [{ text: 'Hello' }] }],
      'You are helpful.',
    );
    expect(messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
  });
});

describe('OpenAICompatibleContentGenerator retry logic', () => {
  it('does not retry on 401 auth errors', async () => {
    const generator = createGenerator();
    // Access the private client to set up the mock
    const client = (
      generator as unknown as {
        client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
      }
    ).client;
    let callCount = 0;
    client.chat.completions.create = vi.fn().mockImplementation(() => {
      callCount++;
      const error: Error & { status?: number } = new Error('Unauthorized');
      error.status = 401;
      throw error;
    });

    await expect(
      generator.generateContent(makeRequest('test'), 'prompt-1', LlmRole.MAIN),
    ).rejects.toThrow('Unauthorized');
    expect(callCount).toBe(1); // No retries
  });

  it('retries on 429 rate limit', async () => {
    const generator = new OpenAICompatibleContentGenerator({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:11434/v1',
      model: 'test-model',
      retryBackoffMs: 1, // Fast retries for testing
      retryAttempts: 3,
    });

    const client = (
      generator as unknown as {
        client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } };
      }
    ).client;
    let callCount = 0;
    client.chat.completions.create = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        const error: Error & { status?: number } = new Error('Rate limited');
        error.status = 429;
        throw error;
      }
      return {
        id: 'chatcmpl-ok',
        model: 'test-model',
        choices: [
          {
            message: { content: 'Success', role: 'assistant' },
            finish_reason: 'stop',
          },
        ],
      };
    });

    const result = await generator.generateContent(
      makeRequest('test'),
      'prompt-1',
      LlmRole.MAIN,
    );
    expect(callCount).toBe(3);
    expect(result.candidates?.[0]?.content?.parts?.[0]?.text).toBe('Success');
  });
});
