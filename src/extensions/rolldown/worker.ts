/*
 * rolldown worker: runs the oxc WASM primitives (via
 * @rolldown/binding-wasm32-wasi's browser glue) off the main thread.
 *
 * Protocol (plain postMessage request/response):
 *   worker -> { type: 'ready' }              boot ping (module graph loaded)
 *   worker -> { type: 'boot-error', where, error }  caught init failure
 *   { id, type: 'transform' | 'minify', filename, source }
 *     <- { id, ok, result: string }
 *   { id, type: 'bundle', entry, files, format?, ... }   (bundleCore)
 *     <- { id, ok: true, result: BundleCoreResponse }
 *   <- { id, ok: false, error }
 *
 * Every heavy import (binding glue, @rolldown/browser) is DYNAMIC and
 * inside a catch: module-level failures (wasm fetch, glue crashes) surface
 * as catchable errors with a real message posted to the main thread,
 * instead of silently killing the worker (top-level static imports die
 * uncatchably and main thread sees an empty ErrorEvent - the exact
 * "worker error: unknown error" failure mode observed in the browser).
 *
 * Bundling logic lives in bundleCore.ts (kept separate so node sanity
 * tests can exercise it directly).
 */

type TransformMinifyRequest = {
  id: number;
  type: "transform" | "minify";
  filename: string;
  source: string;
};

export type WorkerRequest =
  | TransformMinifyRequest
  | ({ id: number; type: "bundle" } & import("./bundleCore.js").BundleCoreRequest);

type Response =
  | {
      id: number;
      ok: true;
      result: string | import("./bundleCore.js").BundleCoreResponse;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

import "./processShim.js";

/*
 * Forward wasm-runtime diagnostic console.error output (notably the
 * wasi-threads ThreadManager's "worker sent an error! ..." lines) to the
 * main thread, so nested worker failures reach the output channel even
 * when the machinery drops the structured error object.
 */
const originalConsoleError = console.error.bind(console);

console.error = (...args: unknown[]): void => {
  try {
    const text = args
      .map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
      .join(" ");

    if (/worker sent an error|emnapi|wasi|pthread/i.test(text)) {
      self.postMessage({ type: "diagnostic-console", text: text.slice(0, 800) });
    }
  } catch {
    // instrumentation must never break the worker
  }

  originalConsoleError(...args);
};

/*
 * The oxc binding glue (transform/minify primitives) is loaded lazily on
 * first transform/minify request.
 */
type BindingModule = {
  default: {
    transform: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<{ code: string; errors: unknown[] }>;

    minify: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<{ code: string; errors: unknown[] }>;
  };
};

let bindingModule: BindingModule | undefined;

async function ensureBinding(): Promise<BindingModule> {
  if (bindingModule != null) {
    return bindingModule;
  }

  bindingModule = await import("@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js");

  return bindingModule;
}

function reportBootError(where: string, error: unknown): void {
  self.postMessage({
    type: "boot-error",
    where,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
}

function formatInitError(where: string, error: unknown): Error {
  const cause = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);

  return new Error(`[rolldown] failed to load ${where}: ${cause}`);
}

async function transpile(request: TransformMinifyRequest): Promise<Response> {
  const operation = request.type === "transform" ? "transform" : "minify";

  const module = await ensureBinding();

  const result = await module.default[operation](request.filename, request.source);

  if (result.errors.length > 0) {
    throw new Error(result.errors.map((error: unknown) => JSON.stringify(error)).join("\n"));
  }

  return { id: request.id, ok: true, result: result.code };
}

async function bundleRequest(
  request: { id: number } & import("./bundleCore.js").BundleCoreRequest,
): Promise<Response> {
  try {
    const { bundle } = await import("./bundleCore.js");

    return {
      id: request.id,
      ok: true,
      result: await bundle(request),
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: formatInitError("rolldown bundler", error).message,
    };
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const request = event.data;

  if (request?.type == null) {
    return;
  }

  let response: Response | undefined;

  try {
    if (request.type === "bundle") {
      response = await bundleRequest(request);
    } else if (request.type === "transform" || request.type === "minify") {
      response = await transpile(request);
    } else {
      throw new Error(`Unsupported rolldown operation: ${(request as { type: string }).type}`);
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (response != null) {
    self.postMessage(response);
  }
};

/*
 * Boot is now LIGHT (no static wasm imports). Heavy loads happen lazily on
 * first request, through bundleRequest/transpile's catch (dynamic-import
 * chains make glue-internal top-level failures catchable). Signal
 * readiness to the main thread immediately; report a boot error if the
 * module graph itself could not finish.
 */
try {
  self.postMessage({ type: "ready" });
} catch (error) {
  reportBootError("worker module", error);
}
