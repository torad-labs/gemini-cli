/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MLflow tracing integration for multi-provider observability.
 *
 * Wraps session, turn, LLM call, and tool execution spans using mlflow-tracing.
 * Gracefully degrades to JSON stdout logging when MLFLOW_TRACKING_URI is not set.
 */

import type { LiveSpan } from 'mlflow-tracing';

let mlflowAvailable = false;
let mlflowModule: typeof import('mlflow-tracing') | null = null;

/**
 * Initialize MLflow tracing. Call once at startup.
 * If MLFLOW_TRACKING_URI is not set, all trace functions become pass-through.
 */
export async function initMlflowTracing(): Promise<boolean> {
  const trackingUri = process.env['MLFLOW_TRACKING_URI'];
  if (!trackingUri) {
    mlflowAvailable = false;
    return false;
  }

  try {
    mlflowModule = await import('mlflow-tracing');
    mlflowModule.init({
      trackingUri,
      experimentId: process.env['MLFLOW_EXPERIMENT_ID'],
    } as Parameters<typeof mlflowModule.init>[0]);
    mlflowAvailable = true;

    // Register span end hook for meaningful span names
    mlflowModule.registerOnSpanEndHook((span: LiveSpan) => {
      const attrs: Record<string, unknown> =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- accessing span internal attributes
        (span as unknown as { attributes?: Record<string, unknown> })
          .attributes ?? {};
      if (attrs['model']) {
        span.setAttributes({
          displayName: `${String(attrs['provider'])}/${String(attrs['model'])}`,
        });
      }
    });

    return true;
  } catch {
    mlflowAvailable = false;
    return false;
  }
}

/**
 * Wrap a session lifecycle in an AGENT span.
 */
export async function traceSession<T>(
  sessionId: string,
  agentId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!mlflowAvailable || !mlflowModule) {
    return logAndExecute('session', { sessionId, agentId }, fn);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- withSpan returns matching generic type
  return mlflowModule.withSpan(
    async (span: LiveSpan) => {
      span.setAttributes({ sessionId, agentId });
      return fn();
    },
    {
      name: `session:${sessionId}`,
      spanType: mlflowModule.SpanType.AGENT,
      inputs: { sessionId, agentId },
    },
  ) as Promise<T>;
}

/**
 * Wrap a turn in a CHAIN span.
 */
export async function traceTurn<T>(
  turnId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!mlflowAvailable || !mlflowModule) {
    return logAndExecute('turn', { turnId }, fn);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- withSpan returns matching generic type
  return mlflowModule.withSpan(
    async (span: LiveSpan) => {
      span.setAttributes({ turnId });
      return fn();
    },
    {
      name: `turn:${turnId}`,
      spanType: mlflowModule.SpanType.CHAIN,
      inputs: { turnId },
    },
  ) as Promise<T>;
}

/**
 * Wrap an LLM call in an LLM span with token and latency attributes.
 */
export async function traceLlmCall<T>(
  model: string,
  provider: string,
  fn: () => T | Promise<T>,
  options?: {
    baseUrl?: string;
    promptTokens?: number;
    completionTokens?: number;
    finishReason?: string;
  },
): Promise<T> {
  if (!mlflowAvailable || !mlflowModule) {
    return logAndExecute('llm', { model, provider, ...options }, fn);
  }

  const start = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- withSpan returns matching generic type
  return mlflowModule.withSpan(
    async (span: LiveSpan) => {
      span.setAttributes({
        model,
        provider,
        ...(options?.baseUrl && { baseUrl: options.baseUrl }),
      });
      const result = await fn();
      const latencyMs = Date.now() - start;
      span.setAttributes({
        latencyMs,
        ...(options?.promptTokens !== undefined && {
          promptTokens: options.promptTokens,
        }),
        ...(options?.completionTokens !== undefined && {
          completionTokens: options.completionTokens,
        }),
        ...(options?.finishReason && { finishReason: options.finishReason }),
      });
      return result;
    },
    {
      name: `llm:${provider}/${model}`,
      spanType: mlflowModule.SpanType.LLM,
      inputs: { model, provider },
    },
  ) as Promise<T>;
}

/**
 * Wrap a tool execution in a TOOL span.
 */
export async function traceToolCall<T>(
  toolName: string,
  callId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!mlflowAvailable || !mlflowModule) {
    return logAndExecute('tool', { toolName, callId }, fn);
  }

  const start = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- withSpan returns matching generic type
  return mlflowModule.withSpan(
    async (span: LiveSpan) => {
      span.setAttributes({ toolName, callId });
      try {
        const result = await fn();
        const durationMs = Date.now() - start;
        span.setAttributes({ status: 'success', durationMs });
        return result;
      } catch (error: unknown) {
        const durationMs = Date.now() - start;
        const errObj =
          error instanceof Error ? error : new Error('Unknown error');
        span.setAttributes({
          status: 'error',
          durationMs,
          errorMessage: errObj.message,
          errorType: errObj.constructor.name,
        });
        throw error;
      }
    },
    {
      name: `tool:${toolName}`,
      spanType: mlflowModule.SpanType.TOOL,
      inputs: { toolName, callId },
    },
  ) as Promise<T>;
}

/**
 * Set token usage attributes on the current span (if MLflow is active).
 */
export function setTokenUsage(
  promptTokens: number,
  completionTokens: number,
  finishReason?: string,
): void {
  if (!mlflowAvailable || !mlflowModule) return;

  const span = mlflowModule.getCurrentActiveSpan();
  if (span) {
    span.setAttributes({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(finishReason && { finishReason }),
    });
  }
}

// ---------------------------------------------------------------------------
// Fallback: JSON stdout logging when MLflow is not available
// ---------------------------------------------------------------------------

async function logAndExecute<T>(
  spanType: string,
  attributes: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Only log if explicitly opted in via env var (avoid noise)
  if (process.env['GEMINI_CLI_TRACE_LOG'] === 'true') {
    const timestamp = new Date().toISOString();
    // eslint-disable-next-line no-console -- fallback tracer output when MLflow unavailable
    console.log(
      JSON.stringify({ type: 'trace_start', spanType, attributes, timestamp }),
    );
  }

  const start = Date.now();
  try {
    const result = await fn();
    if (process.env['GEMINI_CLI_TRACE_LOG'] === 'true') {
      // eslint-disable-next-line no-console -- fallback tracer output when MLflow unavailable
      console.log(
        JSON.stringify({
          type: 'trace_end',
          spanType,
          durationMs: Date.now() - start,
          status: 'success',
        }),
      );
    }
    return result;
  } catch (error: unknown) {
    if (process.env['GEMINI_CLI_TRACE_LOG'] === 'true') {
      const errMessage =
        error instanceof Error ? error.message : 'Unknown error';
      // eslint-disable-next-line no-console -- fallback tracer output when MLflow unavailable
      console.log(
        JSON.stringify({
          type: 'trace_end',
          spanType,
          durationMs: Date.now() - start,
          status: 'error',
          error: errMessage,
        }),
      );
    }
    throw error;
  }
}
