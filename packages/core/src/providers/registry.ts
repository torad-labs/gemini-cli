/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider registry — routes ContentGenerator creation based on provider type.
 */

import type { ContentGenerator } from '../core/contentGenerator.js';
import {
  OpenAICompatibleContentGenerator,
  type OpenAIProviderConfig,
} from './openai-compatible.js';

export type ProviderType = 'google-genai' | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  defaultHeaders?: Record<string, string>;
  timeout?: number;
  firstTokenTimeout?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
}

export class ProviderRegistry {
  /**
   * Create a ContentGenerator for the given provider config.
   * For 'google-genai', returns undefined — caller should use existing path.
   * For 'openai-compatible', creates an OpenAICompatibleContentGenerator.
   */
  create(config: ProviderConfig): ContentGenerator | undefined {
    switch (config.type) {
      case 'google-genai':
        return undefined; // Caller uses existing Google GenAI path

      case 'openai-compatible':
        if (!config.baseUrl) {
          throw new Error(
            'OpenAI-compatible provider requires a baseUrl (e.g., OPENAI_BASE_URL)',
          );
        }
        return new OpenAICompatibleContentGenerator({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          defaultHeaders: config.defaultHeaders,
          timeout: config.timeout,
          firstTokenTimeout: config.firstTokenTimeout,
          retryAttempts: config.retryAttempts,
          retryBackoffMs: config.retryBackoffMs,
        } satisfies OpenAIProviderConfig);

      default:
        throw new Error(
          `Unknown provider type: "${config.type}". Supported: google-genai, openai-compatible`,
        );
    }
  }
}
