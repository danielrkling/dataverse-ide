/*
 * terminal history sanity harness (manual).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/terminalHistory.sanity.mts --bundle --platform=node \
 *     --format=esm --outfile=.tmp-terminal-history.mjs
 *   node .tmp-terminal-history.mjs
 *   rm .tmp-terminal-history.mjs
 *
 * The IndexedDB-backed store is covered by the browser integration; this
 * harness exercises the merge/debounce/limit logic with an in-memory store.
 */

import assert from "node:assert/strict";

import { createShellHistory, type HistoryStore } from "../src/extensions/terminal/history.ts";

function createMemoryStore(): HistoryStore & { commands: string[] } {
  const store = {
    commands: [] as string[],

    async read(): Promise<string[]> {
      return [...store.commands];
    },

    async write(commands: string[]): Promise<void> {
      store.commands = [...commands];
    },
  };

  return store;
}

const store = createMemoryStore();
const first = createShellHistory(store, { limit: 3 });

assert.deepEqual(await first.load(), []);

first.append("ls");
first.append("echo one\necho two");
await first.flush();

assert.deepEqual(store.commands, ["ls", "echo one\necho two"]);

const second = createShellHistory(store, { limit: 3 });

assert.deepEqual(await second.load(), ["ls", "echo one\necho two"]);

second.append("pwd");
await second.flush();

assert.deepEqual(store.commands, ["ls", "echo one\necho two", "pwd"]);

for (const command of ["one", "two", "three", "four"]) {
  first.append(command);
}

await first.flush();

assert.deepEqual(store.commands, ["two", "three", "four"]);

console.log("terminal history sanity: ok");
