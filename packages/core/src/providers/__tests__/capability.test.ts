/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { probeCapabilities, clearCapabilityCache } from '../capability.js';
import type { ContentGenerator } from '../../core/contentGenerator.js';
import type { GenerateContentResponse } from '@google/genai';

// Mock ContentGenerator
function createMockGenerator(
  options: {
    supportsTools?: boolean;
    supportsVision?: boolean;
    throwOnTools?: Error;
    throwOnVision?: Error;
  } = {},
): ContentGenerator {
  return {
    generateContent: vi.fn().mockImplementation(async (request) => {
      // Check if this is a capability probe for tools
      if (request.config?.tools) {
        if (options.throwOnTools) {
          throw options.throwOnTools;
        }
        if (options.supportsTools === false) {
          throw new Error('Tools not supported');
        }
        return {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'test' }] },
            },
          ],
        } as GenerateContentResponse;
      }

      // Check if this is a capability probe for vision (has inlineData)
      const hasImage = request.contents?.some(
        (c: { parts?: Array<{ inlineData?: unknown }> }) =>
          c.parts?.some((p) => 'inlineData' in p),
      );
      if (hasImage) {
        if (options.throwOnVision) {
          throw options.throwOnVision;
        }
        if (options.supportsVision === false) {
          throw new Error('Vision not supported');
        }
        return {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'An image' }] },
            },
          ],
        } as GenerateContentResponse;
      }

      // Default response
      return {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'response' }] },
          },
        ],
      } as GenerateContentResponse;
    }),
    generateContentStream: vi.fn(),
    countTokens: vi.fn(),
    embedContent: vi.fn(),
  };
}

describe('probeCapabilities', () => {
  beforeEach(() => {
    clearCapabilityCache();
  });

  it('returns supportsToolCalling=true when tool request succeeds', async () => {
    const generator = createMockGenerator({ supportsTools: true });
    const result = await probeCapabilities(generator, 'test-model');

    expect(result.supportsToolCalling).toBe(true);
  });

  it('returns supportsToolCalling=false when tool request fails', async () => {
    const generator = createMockGenerator({
      throwOnTools: new Error('Tools not supported'),
    });
    const result = await probeCapabilities(generator, 'test-model');

    expect(result.supportsToolCalling).toBe(false);
  });

  it('returns supportsVision=true when image request succeeds', async () => {
    const generator = createMockGenerator({ supportsVision: true });
    const result = await probeCapabilities(generator, 'test-model');

    expect(result.supportsVision).toBe(true);
  });

  it('returns supportsVision=false when image request fails', async () => {
    const generator = createMockGenerator({
      throwOnVision: new Error('Vision not supported'),
    });
    const result = await probeCapabilities(generator, 'test-model');

    expect(result.supportsVision).toBe(false);
  });

  it('returns supportsStreaming=true by default', async () => {
    const generator = createMockGenerator();
    const result = await probeCapabilities(generator, 'test-model');

    expect(result.supportsStreaming).toBe(true);
  });

  it('caches results per model', async () => {
    const generator = createMockGenerator({ supportsTools: true });

    // First call
    const result1 = await probeCapabilities(generator, 'test-model');
    expect(result1.supportsToolCalling).toBe(true);

    // Second call should use cache
    const result2 = await probeCapabilities(generator, 'test-model');
    expect(result2).toBe(result1); // Same object reference

    // Different model should not use cache
    const result3 = await probeCapabilities(generator, 'other-model');
    expect(result3).not.toBe(result1);
  });

  it('clearCapabilityCache allows re-probing', async () => {
    const generator = createMockGenerator({ supportsTools: true });

    const result1 = await probeCapabilities(generator, 'test-model');
    clearCapabilityCache();
    const result2 = await probeCapabilities(generator, 'test-model');

    expect(result2).not.toBe(result1); // Different object
  });

  it('uses correct probe function name constant', async () => {
    const generator = createMockGenerator();
    await probeCapabilities(generator, 'test-model');

    const mockFn = generator.generateContent as ReturnType<typeof vi.fn>;
    const calls = mockFn.mock.calls as unknown[][][];
    const toolProbeCall = calls.find((call) => {
      if (!call?.[0] || typeof call[0] !== 'object') return false;
      const req = call[0] as {
        config?: {
          tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
        };
      };
      return req.config?.tools?.[0]?.functionDeclarations?.[0]?.name;
    });

    const req = toolProbeCall?.[0] as
      | {
          config?: {
            tools?: Array<{ functionDeclarations?: Array<{ name?: string }> }>;
          };
        }
      | undefined;
    expect(req?.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe(
      '_capability_probe',
    );
  });
});
