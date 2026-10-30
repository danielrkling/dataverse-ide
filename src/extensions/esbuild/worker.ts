/*
 * Deprecated esbuild worker entrypoint.
 *
 * Esbuild now runs on the main thread through:
 *
 *   src/extensions/esbuild/compiler.ts
 *   src/extensions/esbuild/buildRunner.ts
 *
 * This file remains as a small compatibility stub so old cached worker URLs
 * or stale development artifacts fail with a clear message instead of an
 * opaque worker initialization error.
 *
 * Do not import compiler.ts here: the main-thread compiler accepts a live
 * WorkspaceReader backed by vscode.workspace.fs, which cannot be transferred
 * through postMessage to a dedicated worker.
 */

import type { BuildOutputFile } from "./compiler.js";

export type { BuildOutputFile };

type LegacyWorkerRequest = {
  id?: number;
  type?: "build" | "transform";
};

type LegacyWorkerResponse = {
  id: number;
  ok: false;
  error: string;
};

self.onmessage = (event: MessageEvent<LegacyWorkerRequest>): void => {
  const request = event.data;

  const response: LegacyWorkerResponse = {
    id: request?.id ?? 0,
    ok: false,
    error:
      "[esbuild] The dedicated esbuild worker is no longer used. " +
      "Reload Dataverse IDE so builds use the main-thread compiler.",
  };

  self.postMessage(response);
};