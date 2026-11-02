/*
 * Best-effort network gate for the direct-fs Node runtime.
 *
 * User modules execute in the extension-host worker and share its globals.
 * While a run with `network: "blocked"` is active we temporarily replace the
 * common outbound APIs. This is a guardrail, not a security boundary: code
 * can still reach the network through APIs we do not wrap (workers,
 * importScripts, cached constructors, ...). A real boundary needs a
 * dedicated worker with brokered network access.
 */

type Restorable = {
  restore: () => void;
};

class NetworkPermissionError extends Error {
  constructor(api: string) {
    super(`EACCES: network access denied by node-runtime permissions (${api})`);
    this.name = "NetworkPermissionError";
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function isNetworkUrl(value: string): boolean {
  try {
    const locationHref =
      (globalThis as typeof globalThis & { location?: { href?: string } }).location?.href ??
      "https://localhost/";
    const url = new URL(value, locationHref);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:"
    );
  } catch {
    /*
     * Unparseable targets are treated as network requests so the failure
     * mode is deny-by-default.
     */
    return true;
  }
}

function deniedConstructor(api: string): new (...args: unknown[]) => never {
  return class {
    constructor() {
      throw new NetworkPermissionError(api);
    }
  } as unknown as new (...args: unknown[]) => never;
}

export function blockNetworkAccess(): Restorable {
  const target = globalThis as unknown as Record<string, unknown>;

  const originalFetch = target.fetch as
    ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
  const originalXhr = target.XMLHttpRequest;
  const originalWebSocket = target.WebSocket;
  const originalEventSource = target.EventSource;
  const originalBeacon =
    typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : undefined;

  let wrappedFetch: unknown;

  if (originalFetch != null) {
    wrappedFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (isNetworkUrl(requestUrl(input))) {
        return Promise.reject(new NetworkPermissionError("fetch"));
      }

      return originalFetch.call(target, input, init);
    };

    target.fetch = wrappedFetch;
  }

  target.XMLHttpRequest = deniedConstructor("XMLHttpRequest");
  target.WebSocket = deniedConstructor("WebSocket");
  target.EventSource = deniedConstructor("EventSource");

  if (originalBeacon != null) {
    try {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        value: () => {
          throw new NetworkPermissionError("navigator.sendBeacon");
        },
      });
    } catch {
      // Some worker navigators expose non-configurable methods.
    }
  }

  return {
    restore() {
      if (originalFetch != null && target.fetch === wrappedFetch) {
        target.fetch = originalFetch;
      }

      if (target.XMLHttpRequest !== originalXhr) {
        target.XMLHttpRequest = originalXhr;
      }

      if (target.WebSocket !== originalWebSocket) {
        target.WebSocket = originalWebSocket;
      }

      if (target.EventSource !== originalEventSource) {
        target.EventSource = originalEventSource;
      }

      if (originalBeacon != null) {
        try {
          Object.defineProperty(navigator, "sendBeacon", {
            configurable: true,
            value: originalBeacon,
          });
        } catch {
          // Ignore.
        }
      }
    },
  };
}

export { NetworkPermissionError };
