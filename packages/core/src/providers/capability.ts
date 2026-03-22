/**
 * @license
 * Copyright 2026 Google LLC
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

/** Constant for the probe function name used in capability testing. */
const CAPABILITY_PROBE_FUNCTION = '_capability_probe';

/** Minimal 1x1 pixel PNG (base64) for vision capability probing. */
const CAPABILITY_PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

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
                  name: CAPABILITY_PROBE_FUNCTION,
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
      'capability-probe-tools',
      LlmRole.MAIN,
    );
    capabilities.supportsToolCalling = true;
  } catch {
    capabilities.supportsToolCalling = false;
  }

  // Probe vision by sending a minimal test image
  try {
    await provider.generateContent(
      {
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Describe this image.' },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: CAPABILITY_PROBE_IMAGE_BASE64,
                },
              },
            ],
          },
        ],
      },
      'capability-probe-vision',
      LlmRole.MAIN,
    );
    capabilities.supportsVision = true;
  } catch {
    capabilities.supportsVision = false;
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
