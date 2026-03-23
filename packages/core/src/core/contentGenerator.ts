/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  type CountTokensResponse,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type EmbedContentResponse,
  type EmbedContentParameters,
} from '@google/genai';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import type { Config } from '../config/config.js';
import { loadApiKey } from './apiKeyCredentialStorage.js';

import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { InstallationManager } from '../utils/installationManager.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { parseCustomHeaders } from '../utils/customHeaderUtils.js';
import { determineSurface } from '../utils/surface.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';
import { getVersion, resolveModel } from '../../index.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { ProviderRegistry, type ProviderType } from '../providers/registry.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  listModels?(): Promise<string[]>;
  fetchModelMetadata?(): Promise<void>;

  userTier?: UserTierId;

  userTierName?: string;

  paidTier?: GeminiUserTier;
}

export enum AuthType {
  LOGIN_WITH_GOOGLE = 'oauth-personal',
  USE_GEMINI = 'gemini-api-key',
  USE_VERTEX_AI = 'vertex-ai',
  LEGACY_CLOUD_SHELL = 'cloud-shell',
  COMPUTE_ADC = 'compute-default-credentials',
  GATEWAY = 'gateway',
}

/**
 * Detects the best authentication type based on environment variables.
 *
 * Checks in order:
 * 1. GOOGLE_GENAI_USE_GCA=true -> LOGIN_WITH_GOOGLE
 * 2. GOOGLE_GENAI_USE_VERTEXAI=true -> USE_VERTEX_AI
 * 3. GEMINI_API_KEY -> USE_GEMINI
 */
export function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
  if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env['GEMINI_API_KEY']) {
    return AuthType.USE_GEMINI;
  }
  if (
    process.env['CLOUD_SHELL'] === 'true' ||
    process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
  ) {
    return AuthType.COMPUTE_ADC;
  }
  return undefined;
}

export type ContentGeneratorConfig = {
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType;
  proxy?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  providerType?: ProviderType;
  openaiConfig?: {
    baseUrl: string;
    model: string;
    defaultHeaders?: Record<string, string>;
    timeout?: number;
    firstTokenTimeout?: number;
    retryAttempts?: number;
    retryBackoffMs?: number;
  };
};

// ---------------------------------------------------------------------------
// Provider presets and resolution
// ---------------------------------------------------------------------------

interface ResolvedProvider {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout?: number;
  retryAttempts?: number;
}

const PROVIDER_PRESETS: Record<
  string,
  { baseUrl: string; apiKeyEnv: string; defaultModel?: string }
> = {
  'nvidia-nim': {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
  },
  deepinfra: {
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    defaultModel: 'Qwen/Qwen3-235B-A22B',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    apiKeyEnv: '',
    defaultModel: 'llama3.2:1b',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    defaultModel: 'grok-3',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  fireworks: {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
  },
};

/**
 * Resolve an API key value — supports `$ENV_VAR` syntax.
 */
function resolveApiKey(value: string | undefined): string {
  if (!value) return '';
  if (value.startsWith('$')) {
    return process.env[value.slice(1)] ?? '';
  }
  return value;
}

/**
 * Resolve provider config from settings + env vars.
 * Env vars always override settings. Returns undefined for google-genai.
 */
function resolveProviderConfig(settings?: {
  type?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  timeout?: number;
  retryAttempts?: number;
}): ResolvedProvider | undefined {
  // Env vars take precedence over everything
  const envType = process.env['PROVIDER_TYPE'];
  const envBaseUrl = process.env['OPENAI_BASE_URL'];
  const envModel = process.env['OPENAI_MODEL'];
  const envApiKey = process.env['OPENAI_API_KEY'];

  const providerType = envType ?? settings?.type;

  // No provider configured or explicitly google-genai
  if (!providerType || providerType === 'google-genai') {
    return undefined;
  }

  // Check for preset
  const preset = PROVIDER_PRESETS[providerType];

  const baseUrl = envBaseUrl ?? settings?.baseUrl ?? preset?.baseUrl;
  const model = envModel ?? settings?.model ?? preset?.defaultModel;
  const apiKey =
    envApiKey ??
    resolveApiKey(settings?.apiKey) ??
    (preset?.apiKeyEnv ? (process.env[preset.apiKeyEnv] ?? '') : '');

  if (!baseUrl || !model) {
    return undefined;
  }

  return {
    baseUrl,
    model,
    apiKey,
    timeout: settings?.timeout,
    retryAttempts: settings?.retryAttempts,
  };
}

export async function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  apiKey?: string,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
): Promise<ContentGeneratorConfig> {
  const geminiApiKey =
    apiKey ||
    process.env['GEMINI_API_KEY'] ||
    (await loadApiKey()) ||
    undefined;
  const googleApiKey = process.env['GOOGLE_API_KEY'] || undefined;
  const googleCloudProject =
    process.env['GOOGLE_CLOUD_PROJECT'] ||
    process.env['GOOGLE_CLOUD_PROJECT_ID'] ||
    undefined;
  const googleCloudLocation = process.env['GOOGLE_CLOUD_LOCATION'] || undefined;

  const contentGeneratorConfig: ContentGeneratorConfig = {
    authType,
    proxy: config?.getProxy(),
    baseUrl,
    customHeaders,
  };

  // Provider detection: env vars override settings, settings override defaults
  const providerSettings = config.getProviderConfig?.();
  const resolvedProvider = resolveProviderConfig(providerSettings);
  if (resolvedProvider) {
    contentGeneratorConfig.providerType = 'openai-compatible';
    contentGeneratorConfig.apiKey = resolvedProvider.apiKey;
    contentGeneratorConfig.openaiConfig = {
      baseUrl: resolvedProvider.baseUrl,
      model: resolvedProvider.model,
      timeout: resolvedProvider.timeout,
      retryAttempts: resolvedProvider.retryAttempts,
    };
    return contentGeneratorConfig;
  }

  // If we are using Google auth or we are in Cloud Shell, there is nothing else to validate for now
  if (
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.COMPUTE_ADC
  ) {
    return contentGeneratorConfig;
  }

  if (authType === AuthType.USE_GEMINI && geminiApiKey) {
    contentGeneratorConfig.apiKey = geminiApiKey;
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  if (
    authType === AuthType.USE_VERTEX_AI &&
    (googleApiKey || (googleCloudProject && googleCloudLocation))
  ) {
    contentGeneratorConfig.apiKey = googleApiKey;
    contentGeneratorConfig.vertexai = true;

    return contentGeneratorConfig;
  }

  if (authType === AuthType.GATEWAY) {
    contentGeneratorConfig.apiKey = apiKey || 'gateway-placeholder-key';
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const generator = await (async () => {
    // OpenAI-compatible provider routing
    if (config.providerType === 'openai-compatible' && config.openaiConfig) {
      const registry = new ProviderRegistry();
      const provider = registry.create({
        type: 'openai-compatible',
        apiKey: config.apiKey ?? process.env['OPENAI_API_KEY'] ?? '',
        baseUrl: config.openaiConfig.baseUrl,
        model: config.openaiConfig.model,
        defaultHeaders: config.openaiConfig.defaultHeaders,
        timeout: config.openaiConfig.timeout,
        firstTokenTimeout: config.openaiConfig.firstTokenTimeout,
        retryAttempts: config.openaiConfig.retryAttempts,
        retryBackoffMs: config.openaiConfig.retryBackoffMs,
      });
      if (provider) {
        return new LoggingContentGenerator(provider, gcConfig);
      }
    }

    if (gcConfig.fakeResponses) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponses,
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }
    const version = await getVersion();
    const model = resolveModel(
      gcConfig.getModel(),
      config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI ||
        ((await gcConfig.getGemini31Launched?.()) ?? false),
      false,
      gcConfig.getHasAccessToPreviewModel?.() ?? true,
      gcConfig,
    );
    const customHeadersEnv =
      process.env['GEMINI_CLI_CUSTOM_HEADERS'] || undefined;
    const clientName = gcConfig.getClientName();
    const userAgentPrefix = clientName
      ? `torad-code-${clientName}`
      : 'torad-code';
    const surface = determineSurface();
    const userAgent = `${userAgentPrefix}/${version}/${model} (${process.platform}; ${process.arch}; ${surface})`;
    const customHeadersMap = parseCustomHeaders(customHeadersEnv);
    const apiKeyAuthMechanism =
      process.env['GEMINI_API_KEY_AUTH_MECHANISM'] || 'x-goog-api-key';
    const apiVersionEnv = process.env['GOOGLE_GENAI_API_VERSION'];

    const baseHeaders: Record<string, string> = {
      ...customHeadersMap,
      'User-Agent': userAgent,
    };

    if (
      apiKeyAuthMechanism === 'bearer' &&
      (config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI) &&
      config.apiKey
    ) {
      baseHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (
      config.authType === AuthType.LOGIN_WITH_GOOGLE ||
      config.authType === AuthType.COMPUTE_ADC
    ) {
      const httpOptions = { headers: baseHeaders };
      return new LoggingContentGenerator(
        await createCodeAssistContentGenerator(
          httpOptions,
          config.authType,
          gcConfig,
          sessionId,
        ),
        gcConfig,
      );
    }

    if (
      config.authType === AuthType.USE_GEMINI ||
      config.authType === AuthType.USE_VERTEX_AI ||
      config.authType === AuthType.GATEWAY
    ) {
      let headers: Record<string, string> = { ...baseHeaders };
      if (config.customHeaders) {
        headers = { ...headers, ...config.customHeaders };
      }
      if (gcConfig?.getUsageStatisticsEnabled()) {
        const installationManager = new InstallationManager();
        const installationId = installationManager.getInstallationId();
        headers = {
          ...headers,
          'x-gemini-api-privileged-user-id': `${installationId}`,
        };
      }
      let baseUrl = config.baseUrl;
      if (!baseUrl) {
        const envBaseUrl = config.vertexai
          ? process.env['GOOGLE_VERTEX_BASE_URL']
          : process.env['GOOGLE_GEMINI_BASE_URL'];
        if (envBaseUrl) {
          validateBaseUrl(envBaseUrl);
          baseUrl = envBaseUrl;
        }
      } else {
        validateBaseUrl(baseUrl);
      }
      const httpOptions: {
        baseUrl?: string;
        headers: Record<string, string>;
      } = { headers };

      if (baseUrl) {
        httpOptions.baseUrl = baseUrl;
      }

      const googleGenAI = new GoogleGenAI({
        apiKey: config.apiKey === '' ? undefined : config.apiKey,
        vertexai: config.vertexai,
        httpOptions,
        ...(apiVersionEnv && { apiVersion: apiVersionEnv }),
      });
      return new LoggingContentGenerator(googleGenAI.models, gcConfig);
    }
    throw new Error(
      `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
    );
  })();

  if (gcConfig.recordResponses) {
    return new RecordingContentGenerator(generator, gcConfig.recordResponses);
  }

  return generator;
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid custom base URL: ${baseUrl}`);
  }
  if (url.protocol !== 'https:' && !LOCAL_HOSTNAMES.includes(url.hostname)) {
    throw new Error('Custom base URL must use HTTPS unless it is localhost.');
  }
}
