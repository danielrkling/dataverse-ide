/*
 * node-runtime permission sanity harness (manual).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/permissions.sanity.mts --bundle --platform=node \
 *     --format=esm --outfile=.tmp-permissions-sanity.mjs
 *   node .tmp-permissions-sanity.mjs
 *   rm .tmp-permissions-sanity.mjs
 *
 * Exercises the read-only fs guard and the best-effort network gate.
 */

import assert from "node:assert/strict";

import { createRuntimeFs } from "../src/extensions/node-runtime/fsShim.ts";
import {
  blockNetworkAccess,
  NetworkPermissionError,
} from "../src/extensions/node-runtime/networkGate.ts";
import {
  permissionsForLevel,
  type NodePermissionLevel,
} from "../src/extensions/node-runtime/permissions.ts";
import { createWorkspaceFs, type WorkspaceFs } from "../src/extensions/node-runtime/workspace.ts";

const files = new Map<string, Uint8Array>([["src/note.txt", new TextEncoder().encode("hello")]]);

const reader: WorkspaceFs = {
  async readText(path) {
    const bytes = files.get(path);

    return bytes == null ? undefined : new TextDecoder().decode(bytes);
  },
  async readBytes(path) {
    return files.get(path);
  },
  async stat(path) {
    return path === "src"
      ? { type: 2, ctime: 0, mtime: 0, size: 0 }
      : files.has(path)
        ? { type: 1, ctime: 0, mtime: 0, size: files.get(path)!.length }
        : undefined;
  },
  async readDirectory(path) {
    return path === "" || path === "src" ? [["note.txt", 1]] : undefined;
  },
  async writeFile(path, content) {
    files.set(path, content);
  },
  async createDirectory() {},
  async deletePath(path) {
    files.delete(path);
  },
  async rename(from, to) {
    const content = files.get(from);

    if (content != null) {
      files.set(to, content);
      files.delete(from);
    }
  },
  async copy(from, to) {
    const content = files.get(from);

    if (content != null) {
      files.set(to, content);
    }
  },
};

const readOnly = createRuntimeFs({ reader, cwd: "/", writable: false });

await readOnly.hydrate("src/note.txt", "read");
assert.equal(readOnly.fs.readFileSync("src/note.txt", "utf8"), "hello");
assert.throws(() => readOnly.fs.writeFileSync("out/blocked.txt", "nope"), /EACCES/);
assert.throws(() => readOnly.fs.mkdirSync("new-dir"), /EACCES/);
assert.throws(() => readOnly.fs.unlinkSync("src/note.txt"), /EACCES/);
assert.throws(() => readOnly.fs.renameSync("src/note.txt", "moved.txt"), /EACCES/);
assert.throws(() => readOnly.fs.copyFileSync("src/note.txt", "copy.txt"), /EACCES/);
assert.throws(() => readOnly.fs.accessSync("src/note.txt", 2), /EACCES/);
assert.throws(() => readOnly.fs.openSync("src/note.txt", "r+"), /EACCES/);

await assert.rejects(readOnly.promises.writeFile("out/blocked.txt", "nope"), /EACCES/);
await assert.rejects(readOnly.promises.mkdir("new-dir"), /EACCES/);
await assert.rejects(readOnly.promises.unlink("src/note.txt"), /EACCES/);

assert.deepEqual(await readOnly.flush(), { applied: 0, errors: [], changed: [] });
assert.equal(files.has("out/blocked.txt"), false);
assert.equal(files.has("new-dir"), false);
assert.equal(files.has("src/note.txt"), true);

const workspaceWrites: string[] = [];
const fakeVscode = {
  workspace: {
    fs: {
      async writeFile(uri: string) {
        workspaceWrites.push(String(uri));
      },
      async createDirectory() {},
      async delete() {},
      async rename() {},
      async copy() {},
    },
  },
  Uri: {
    joinPath(base: string, ...parts: string[]) {
      return [base, ...parts].join("/");
    },
  },
};

const readOnlyWorkspace = createWorkspaceFs(fakeVscode as never, "root" as never, {
  writable: false,
});

await assert.rejects(readOnlyWorkspace.writeFile("blocked.txt", new Uint8Array()), /EACCES/);
await assert.rejects(readOnlyWorkspace.createDirectory("blocked"), /EACCES/);
await assert.rejects(readOnlyWorkspace.deletePath("blocked.txt", false), /EACCES/);
await assert.rejects(readOnlyWorkspace.rename("a.txt", "b.txt"), /EACCES/);
await assert.rejects(readOnlyWorkspace.copy("a.txt", "b.txt"), /EACCES/);
assert.equal(workspaceWrites.length, 0);

const writable = createRuntimeFs({ reader, cwd: "/", writable: true });

writable.fs.writeFileSync("out/ok.txt", "ok");
assert.equal((await writable.flush()).applied, 1);
assert.equal(new TextDecoder().decode(files.get("out/ok.txt")), "ok");

for (const level of ["read-only", "workspace", "trusted"] as NodePermissionLevel[]) {
  assert.ok(permissionsForLevel(level).filesystem.length > 0);
}

assert.deepEqual(permissionsForLevel("read-only"), {
  filesystem: "read-only",
  network: "blocked",
});
assert.deepEqual(permissionsForLevel("workspace"), {
  filesystem: "read-write",
  network: "blocked",
});
assert.deepEqual(permissionsForLevel("trusted"), {
  filesystem: "read-write",
  network: "allowed",
});

const originalFetch = globalThis.fetch;
const guard = blockNetworkAccess();

try {
  await assert.rejects(
    fetch("https://example.invalid/"),
    (error: unknown) => error instanceof NetworkPermissionError,
  );

  const data = await fetch("data:text/plain,allowed");
  assert.equal(await data.text(), "allowed");
} finally {
  guard.restore();
}

assert.equal(globalThis.fetch, originalFetch);

console.log("OK - node-runtime permissions (read-only fs + network gate) behave as expected.");
