// ingestion-service/src/utils/httpRetry.ts
import axios, { AxiosError, type AxiosRequestConfig } from "axios";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (error: AxiosError, attempt: number) => boolean;
  onRetry?: (error: AxiosError, attempt: number, delayMs: number) => void;
}

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Exponential backoff with 80–120% jitter */
function backoffDelay(baseDelayMs: number, attempt: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return baseDelayMs * 2 ** (attempt - 1) * jitter;
}

/** Default: retry on rate limits, server errors, and network-level failures. */
function defaultShouldRetry(error: AxiosError): boolean {
  if (!error.response) return true; // network error, timeout, DNS, etc.
  return error.response.status === 429 || error.response.status >= 500;
}

/**
 * Runs an axios request with exponential backoff retry.
 */
export async function requestWithRetry<T>(
  config: AxiosRequestConfig,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: AxiosError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.request<T>(config);
      return response.data;
    } catch (err) {
      const error = err as AxiosError;
      lastError = error;

      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }

      const delayMs = backoffDelay(baseDelayMs, attempt);
      onRetry?.(error, attempt, delayMs);
      await wait(delayMs);
    }
  }

  throw lastError;
}