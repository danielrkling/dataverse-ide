/*
 * Sync-fs cache strategy for the direct Node runtime.
 *
 * Lazy (default): a sync read/stat/readdir miss throws MissingPathError and
 * the loader hydrates just that path, then retries the run.
 *
 * Eager: before the run, workspace files are read into the fs cache so sync
 * calls usually hit. The workspace scan skips generated/dependency folders
 * and has file-count and byte caps; paths beyond the caps still hydrate
 * lazily.
 */

import type * as vscodeType from "vscode";

export const NODE_FS_CACHE_MODES = ["lazy", "eager"] as const;

export type NodeFsCacheMode = (typeof NODE_FS_CACHE_MODES)[number];

export const DEFAULT_NODE_FS_CACHE: NodeFsCacheMode = "lazy";

const CONFIG_SECTION = "dataverseIde.nodeRuntime";
const FS_CACHE_KEY = "fsCache";

/*
 * node_modules is excluded from the eager scan. The async module loader
 * already prefetches the modules the entry actually imports, so loading every
 * package file up front would mostly waste memory. Everything outside these
 * folders is preloaded.
 */
export const EAGER_FS_EXCLUDE = "{**/node_modules/**,**/.git/**,**/.ide-build/**,**/dist/**}";

export const EAGER_FS_MAX_FILES = 5000;
export const EAGER_FS_MAX_BYTES = 64 * 1024 * 1024;

export function isNodeFsCacheMode(value: unknown): value is NodeFsCacheMode {
  return typeof value === "string" && (NODE_FS_CACHE_MODES as readonly string[]).includes(value);
}

export function getNodeFsCacheMode(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): NodeFsCacheMode {
  try {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION, rootUri)
      .get<string>(FS_CACHE_KEY, DEFAULT_NODE_FS_CACHE);

    return isNodeFsCacheMode(value) ? value : DEFAULT_NODE_FS_CACHE;
  } catch {
    /*
     * Minimal hosts (test harnesses) may not expose workspace configuration.
     * Lazy is always a safe default.
     */
    return DEFAULT_NODE_FS_CACHE;
  }
}

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
