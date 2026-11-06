/*
 * Shared Dataverse Web API plumbing.
 *
 * Both the web resource uploader and the metadata provisioner talk to the
 * same org with the same headers, retry policy and error shape. Keeping the
 * request layer here avoids two subtly different implementations.
 */

export const REQUEST_TIMEOUT_MS = 60000;
export const PUBLISH_TIMEOUT_MS = 180000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;

export function normalizeApiBaseUrl(value?: string): string {
  const baseUrl = value?.trim() || window.location.origin;

  return baseUrl.replace(/\/+$/, "");
}

export function createDataverseHeaders(solutionUniqueName?: string): Headers {
  const headers = new Headers({
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Content-Type": "application/json; charset=utf-8",
    Accept: "application/json",
    Prefer: "return=representation",
  });

  if (solutionUniqueName?.trim()) {
    headers.set("MSCRM.SolutionUniqueName", solutionUniqueName.trim());
  }

  return headers;
}

export function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

/*
 * Request resilience (ported from dataverse-dev-tools' dataverse service):
 *
 * - Every request runs under an abort timeout (60s default).
 * - 429 responses honor the Retry-After header (seconds or HTTP date) and
 *   are retried up to 3 times.
 * - Transient 5xx responses and network errors are retried with
 *   exponential backoff (300ms base, max 3 attempts).
 *
 * Publishing is special: Dataverse runs it server-side and it regularly
 * takes 20-60s, so it gets a longer timeout and is never retried after a
 * timeout. A timed-out PublishXml may still complete on the server; sending
 * the same publish again can queue duplicate work.
 */
type FetchWithRetryOptions = {
  timeoutMs?: number;
  /** Retry after our own abort timeout. Disabled for non-idempotent work. */
  retryTimeouts?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("Retry-After");

  if (header == null) {
    return undefined;
  }

  const seconds = Number(header);

  if (!Number.isNaN(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = new Date(header).getTime();

  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryTimeouts = options.retryTimeouts ?? true;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.status === 429) {
        if (attempt < MAX_RETRIES) {
          const retryAfterMs = parseRetryAfterMs(response) ?? 2000;

          await sleep(retryAfterMs);

          continue;
        }
      } else if (response.status >= 500 && response.status < 600 && attempt < MAX_RETRIES) {
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      /*
       * AbortError from our own timeout. A non-idempotent request may still be
       * running on the server, so callers that disable retryTimeouts get a
       * clear timeout error instead of a silent duplicate request.
       */
      if (controller.signal.aborted && !retryTimeouts) {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }

      if (attempt >= MAX_RETRIES) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries.");
}

export async function getDataverseErrorMessage(response: Response): Promise<string> {
  const body = await response.text();

  if (body.length === 0) {
    return `HTTP ${response.status} ${response.statusText}`;
  }

  try {
    const json = JSON.parse(body) as {
      error?: {
        message?: string;
      };
    };

    if (json.error?.message) {
      return `HTTP ${response.status}: ${json.error.message}`;
    }
  } catch {
    // Return the raw response body below.
  }

  return `HTTP ${response.status}: ${body}`;
}
