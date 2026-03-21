/**
 * @license
 * Copyright 2025 Google LLC
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
