/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Model capability probing — discovers what a model supports at runtime.
 */

import { Type } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { LlmRole } from '../telemetry/llmRole.js';

export interface ModelCapabilities {
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  maxContextTokens?: number;
}

const capabilityCache = new Map<string, ModelCapabilities>();

/**
 * Probe a model's capabilities by sending minimal test requests.
 * Results are cached per model string.
 */
export async function probeCapabilities(
  provider: ContentGenerator,
  model: string,
): Promise<ModelCapabilities> {
  const cached = capabilityCache.get(model);
  if (cached) return cached;

  const capabilities: ModelCapabilities = {
    supportsToolCalling: false,
    supportsVision: false,
    supportsStreaming: true, // Assume true; streaming is standard
  };

  // Probe tool calling by sending a request with a dummy tool
  try {
    await provider.generateContent(
      {
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Say "test".' }],
          },
        ],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: '_capability_probe',
                  description: 'Test function for capability probing',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                  },
                },
              ],
            },
          ],
        },
      },
      'capability-probe',
      LlmRole.MAIN,
    );
    capabilities.supportsToolCalling = true;
  } catch {
    capabilities.supportsToolCalling = false;
  }

  capabilityCache.set(model, capabilities);
  return capabilities;
}

/**
 * Clear the capability cache (useful for testing).
 */
export function clearCapabilityCache(): void {
  capabilityCache.clear();
}
