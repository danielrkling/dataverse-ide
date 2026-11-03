/*
 * ensureWorkspaceDirectory sanity harness (manual).
 *
 * Run (from the repo root):
 *
 *   node --experimental-strip-types tests/workspaceFs.sanity.mts
 *
 * Regression guard for the write-path slowdown: `createDirectory` resolves
 * an existing folder with metadata (readdir + stat per child), so the helper
 * must check `stat` first and only create missing folders.
 */

import assert from "node:assert/strict";

import { ensureWorkspaceDirectory } from "../src/workspace/workspaceFs.ts";

type Calls = { stat: number; create: number };

function fakeVscode(exists: boolean): { vscode: unknown; calls: Calls } {
  const calls: Calls = { stat: 0, create: 0 };

  return {
    calls,
    vscode: {
      workspace: {
        fs: {
          async stat() {
            calls.stat += 1;

            if (!exists) {
              throw new Error("FileNotFound");
            }

            return { type: 2, ctime: 0, mtime: 0, size: 0 };
          },
          async createDirectory() {
            calls.create += 1;
          },
        },
      },
    },
  };
}

const uri = { path: "/workspace/dist" } as never;

const existing = fakeVscode(true);
await ensureWorkspaceDirectory(existing.vscode as never, uri);
assert.deepEqual(existing.calls, { stat: 1, create: 0 }, "existing dir must not be recreated");

const missing = fakeVscode(false);
await ensureWorkspaceDirectory(missing.vscode as never, uri);
assert.deepEqual(missing.calls, { stat: 1, create: 1 }, "missing dir must be created once");

console.log("workspaceFs sanity: ok");
