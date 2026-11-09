/*
 * Minimal OpenAI-compatible chat client.
 *
 * The IDE runs entirely in the browser, so requests go straight to the
 * configured endpoint with fetch(). Endpoints must therefore allow CORS for
 * the app's origin. Most major providers and gateways now do; certain Azure
 * OpenAI configurations and self-hosted servers may not until CORS is
 * enabled. A CORS-enabled proxy can be used instead by changing the base URL.
 */

export type OpenAiChatRole = "system" | "user" | "assistant";

export type OpenAiChatMessage = {
  role: OpenAiChatRole;
  content: string;
};

export type OpenAiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAiRequestMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      tool_calls?: OpenAiToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export type OpenAiAssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
};

export type StreamChatOptions = {
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
  /**
   * Optional Power Automate (or similar) pass-through endpoint. When set,
   * requests are wrapped as { url, method, headers, body } and sent there.
   * The proxy must return the upstream response body.
   */
  proxyUrl?: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
};

export type ChatCompletionOptions = {
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
  proxyUrl?: string;
  model: string;
  messages: OpenAiRequestMessage[];
  tools?: OpenAiToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();

    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export function isAzureEndpoint(baseUrl: string, apiVersion: string): boolean {
  if (apiVersion.trim().length > 0) {
    return true;
  }

  try {
    return /\.openai\.azure\.com$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function chatCompletionsUrl(baseUrl: string, apiVersion = ""): string {
  const trimmed = baseUrl.trim();

  if (trimmed.length === 0) {
    throw new Error("Set an API base URL for Dataverse AI.");
  }

  if (/\/chat\/completions(?:\?.*)?$/i.test(trimmed)) {
    return trimmed;
  }

  const [path, query = ""] = trimmed.split("?");
  const normalizedPath = path.replace(/\/+$/, "");
  const normalizedVersion = apiVersion.trim();
  const parameters = new URLSearchParams(query);

  if (normalizedVersion.length > 0 && !parameters.has("api-version")) {
    parameters.set("api-version", normalizedVersion);
  }

  const suffix = parameters.toString();

  return `${normalizedPath}/chat/completions${suffix.length > 0 ? `?${suffix}` : ""}`;
}

type RequestTarget = {
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
};

function requestHeaders(options: RequestTarget, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: accept,
  };

  if (options.apiKey.trim().length === 0) {
    return headers;
  }

  if (isAzureEndpoint(options.baseUrl, options.apiVersion ?? "")) {
    headers["api-key"] = options.apiKey.trim();
  } else {
    headers.Authorization = `Bearer ${options.apiKey.trim()}`;
  }

  return headers;
}

/*
 * Optional pass-through proxy (for example a Power Automate HTTP flow). The
 * envelope matches the flow contract used by the standalone agent script:
 *
 *   { url, method, headers, body }
 *
 * Browser-controlled headers are removed before forwarding.
 */
async function fetchUpstream(
  url: string,
  init: RequestInit,
  proxyUrl: string | undefined,
): Promise<Response> {
  const trimmedProxy = proxyUrl?.trim() ?? "";

  if (trimmedProxy.length === 0) {
    return fetch(url, init);
  }

  const headers = new Headers(init.headers);

  for (const name of [
    "host",
    "content-length",
    "origin",
    "referer",
    "connection",
    "accept-encoding",
  ]) {
    headers.delete(name);
  }

  const body =
    init.method === "GET" || init.method === "HEAD" || init.body == null
      ? ""
      : typeof init.body === "string"
        ? init.body
        : String(init.body);

  return fetch(trimmedProxy, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      method: init.method ?? "POST",
      headers: Object.fromEntries(headers.entries()),
      body,
    }),
    signal: init.signal,
  });
}

function deltaText(payload: unknown): string {
  if (typeof payload !== "object" || payload == null) {
    return "";
  }

  const choices = (payload as { choices?: unknown }).choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }

  const choice = choices[0] as Record<string, unknown>;
  const delta = choice.delta;

  if (typeof delta === "object" && delta != null) {
    const content = (delta as { content?: unknown }).content;

    if (typeof content === "string") {
      return content;
    }

    /* Some gateways stream an array of content parts. */
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }

          if (typeof part === "object" && part != null) {
            const text = (part as { text?: unknown }).text;

            return typeof text === "string" ? text : "";
          }

          return "";
        })
        .join("");
    }
  }

  /* Non-streaming fallbacks seen in the wild. */
  const text = choice.text;

  if (typeof text === "string") {
    return text;
  }

  const message = choice.message;

  if (typeof message === "object" && message != null) {
    const content = (message as { content?: unknown }).content;

    return typeof content === "string" ? content : "";
  }

  return "";
}

function errorMessageFor(status: number, body: string): string {
  const trimmed = body.trim();

  if (trimmed.length === 0) {
    return `The model endpoint returned HTTP ${status}.`;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };

    if (typeof parsed.error === "string") {
      return parsed.error;
    }

    if (typeof parsed.error?.message === "string") {
      return parsed.error.message;
    }

    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Not JSON; use the raw body below.
  }

  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed;
}

function responseChoices(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload == null) {
    return [];
  }

  const choices = (payload as { choices?: unknown }).choices;

  return Array.isArray(choices) ? choices : [];
}

/*
 * Some proxy flows return the upstream response as { status, headers, body }
 * instead of passing it through untouched. Accept both shapes.
 */
function unwrapProxyPayload(payload: unknown): unknown {
  if (payload == null || typeof payload !== "object" || "choices" in payload) {
    return payload;
  }

  const wrapper = payload as { status?: unknown; statusCode?: unknown; body?: unknown };
  const status =
    typeof wrapper.status === "number"
      ? wrapper.status
      : typeof wrapper.statusCode === "number"
        ? wrapper.statusCode
        : undefined;

  if (status !== undefined && "body" in wrapper) {
    const bodyText = typeof wrapper.body === "string" ? wrapper.body : JSON.stringify(wrapper.body);

    if (status >= 400) {
      throw new Error(errorMessageFor(status, bodyText));
    }

    if (typeof wrapper.body === "string") {
      try {
        return JSON.parse(wrapper.body);
      } catch {
        return wrapper.body;
      }
    }

    return wrapper.body;
  }

  return payload;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(errorMessageFor(response.status, text));
  }

  if (text.trim().length === 0) {
    throw new Error("The model endpoint returned an empty response.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The model endpoint returned a non-JSON response (${response.status}). ` +
        "A proxy must forward the upstream JSON body with Content-Type: application/json.",
    );
  }
}

export async function createChatCompletion(
  options: ChatCompletionOptions,
): Promise<OpenAiAssistantMessage> {
  const url = chatCompletionsUrl(options.baseUrl, options.apiVersion);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: false,
  };

  if (options.tools != null && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = "auto";
  }

  if (options.temperature != null && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature;
  }

  if (options.maxTokens != null && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }

  let response: Response;

  try {
    response = await fetchUpstream(
      url,
      {
        method: "POST",
        headers: requestHeaders(options, "application/json"),
        body: JSON.stringify(body),
        signal: options.signal,
      },
      options.proxyUrl,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Could not reach ${options.proxyUrl?.trim() ? "the proxy" : url}. ` +
        `Check the API base URL/proxy URL and CORS. ${reason}`,
    );
  }

  const payload = unwrapProxyPayload(await readResponsePayload(response));

  if (typeof payload === "object" && payload != null && "error" in payload) {
    throw new Error(errorMessageFor(response.status, JSON.stringify(payload)));
  }

  const choices = responseChoices(payload);
  const message = (choices[0] as { message?: unknown } | undefined)?.message;

  if (message == null || typeof message !== "object") {
    throw new Error("The model endpoint returned no assistant message.");
  }

  return message as OpenAiAssistantMessage;
}

export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  /*
   * Power Automate and most pass-through proxies cannot stream SSE. Use a
   * normal chat completion and emit the final text as one delta.
   */
  if (options.proxyUrl != null && options.proxyUrl.trim().length > 0) {
    const message = await createChatCompletion({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiVersion: options.apiVersion,
      proxyUrl: options.proxyUrl,
      model: options.model,
      messages: options.messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: options.signal,
    });
    const text = message.content ?? "";

    if (text.length > 0) {
      options.onDelta(text);
    }

    return;
  }

  const url = chatCompletionsUrl(options.baseUrl, options.apiVersion);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true,
  };

  if (options.temperature != null && Number.isFinite(options.temperature)) {
    body.temperature = options.temperature;
  }

  if (options.maxTokens != null && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }

  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders(options, "text/event-stream"),
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);

    throw new Error(
      `Could not reach ${url}. Check the API base URL and that the endpoint allows CORS from this page. ${reason}`,
    );
  }

  if (!response.ok) {
    throw new Error(errorMessageFor(response.status, await response.text()));
  }

  if (response.body == null) {
    throw new Error("The model endpoint returned an empty response.");
  }

  const contentType = response.headers.get("content-type") ?? "";

  /*
   * Some servers ignore `stream: true` and return one JSON document. Handle
   * that as a single delta instead of failing in the SSE parser.
   */
  if (contentType.includes("application/json")) {
    const payload: unknown = await response.json();
    const text = deltaText(payload);

    if (text.length > 0) {
      options.onDelta(text);
    }

    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      /*
       * SSE events are separated by a blank line. Keep the trailing partial
       * event in the buffer until the next chunk arrives.
       */
      const boundary = /\r?\n\r?\n/;
      let match = boundary.exec(buffer);

      while (match != null) {
        const event = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        for (const line of event.split(/\r?\n/)) {
          const trimmed = line.trim();

          if (!trimmed.startsWith("data:")) {
            continue;
          }

          const data = trimmed.slice(5).trim();

          if (data.length === 0) {
            continue;
          }

          if (data === "[DONE]") {
            return;
          }

          let payload: unknown;

          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = deltaText(payload);

          if (delta.length > 0) {
            options.onDelta(delta);
          }
        }

        match = boundary.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
