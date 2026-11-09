/*
 * terminal shell sanity harness (manual, like the other *.sanity.*).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/terminalShell.sanity.mts --bundle --platform=node \
 *     --format=esm --external:just-bash --outfile=.tmp-terminal-shell.mjs
 *   node .tmp-terminal-shell.mjs
 *   rm .tmp-terminal-shell.mjs
 *
 * Exercises the workspace-backed IFileSystem with a fake workspace: reads,
 * redirects, glob expansion, cp/mv/rm, cwd tracking, scratch paths, and the
 * read-only guard.
 */

import assert from "node:assert/strict";

import { createShellCommands } from "../src/extensions/terminal/commands.ts";
import { createShellOutput } from "../src/extensions/terminal/output.ts";
import { registerTerminalCommand } from "../src/extensions/terminal/registry.ts";
import { createShellFs } from "../src/extensions/terminal/shellFs.ts";
import { createShellSession } from "../src/extensions/terminal/shell.ts";
import type { WorkspaceFs } from "../src/extensions/node-runtime/workspace.ts";

function createFakeWorkspace() {
  const files = new Map<string, Uint8Array>([
    ["src/a.ts", new TextEncoder().encode("export const a = 1;\n")],
    ["src/sub/b.txt", new TextEncoder().encode("bee\n")],
    ["package.json", new TextEncoder().encode('{"scripts":{"hello":"echo hi"}}')],
    [
      "node_modules/tiny-cli/package.json",
      new TextEncoder().encode('{"name":"tiny-cli","bin":{"tinycli":"./bin/tiny.js"}}'),
    ],
    [
      "node_modules/tiny-cli/bin/tiny.js",
      new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("tiny");\n'),
    ],
    [
      "node_modules/tiny/package.json",
      new TextEncoder().encode('{"name":"tiny","bin":"./cli.js"}'),
    ],
    [
      "node_modules/tiny/cli.js",
      new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("tiny");\n'),
    ],
  ]);
  const dirs = new Set(["", "src", "src/sub"]);

  function ensureDir(path: string): void {
    let current = "";

    dirs.add("");

    for (const part of path.split("/").filter(Boolean)) {
      current = current.length === 0 ? part : `${current}/${part}`;
      dirs.add(current);
    }
  }

  function remove(path: string, recursive: boolean): void {
    if (files.delete(path)) {
      return;
    }

    if (dirs.delete(path)) {
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) {
          files.delete(key);
        }
      }

      return;
    }

    if (!recursive) {
      throw new Error(`ENOENT: ${path}`);
    }

    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        files.delete(key);
      }
    }

    for (const key of [...dirs]) {
      if (key === path || key.startsWith(`${path}/`)) {
        dirs.delete(key);
      }
    }
  }

  const reader: WorkspaceFs = {
    async readText(path) {
      const bytes = files.get(path);

      return bytes == null ? undefined : new TextDecoder().decode(bytes);
    },
    async readBytes(path) {
      return files.get(path);
    },
    async stat(path) {
      if (files.has(path)) {
        return {
          type: 1,
          ctime: 1,
          mtime: 1,
          size: files.get(path)?.length ?? 0,
        } as never;
      }

      if (dirs.has(path)) {
        return { type: 2, ctime: 1, mtime: 1, size: 0 } as never;
      }

      return undefined;
    },
    async readDirectory(path) {
      if (!dirs.has(path)) {
        return undefined;
      }

      const prefix = path.length === 0 ? "" : `${path}/`;
      const names = new Map<string, number>();

      for (const key of [...files.keys(), ...dirs]) {
        if (key === path || !key.startsWith(prefix)) {
          continue;
        }

        const rest = key.slice(prefix.length);
        const [name, ...tail] = rest.split("/");

        names.set(name, tail.length > 0 ? 2 : files.has(key) ? 1 : 2);
      }

      return [...names.entries()];
    },
    async writeFile(path, content) {
      files.set(path, content);
      ensureDir(path.split("/").slice(0, -1).join("/"));
    },
    async createDirectory(path) {
      ensureDir(path);
    },
    async deletePath(path, recursive) {
      remove(path, recursive);
    },
    async rename(from, to) {
      const bytes = files.get(from);

      if (bytes == null) {
        throw new Error(`ENOENT: ${from}`);
      }

      files.delete(from);
      files.set(to, bytes);
      ensureDir(to.split("/").slice(0, -1).join("/"));
    },
    async copy(from, to) {
      const bytes = files.get(from);

      if (bytes == null) {
        throw new Error(`ENOENT: ${from}`);
      }

      files.set(to, bytes);
      ensureDir(to.split("/").slice(0, -1).join("/"));
    },
  };

  return { files, dirs, reader };
}

async function createFs(workspace: ReturnType<typeof createFakeWorkspace>, writable: boolean) {
  return createShellFs({
    vscode: {
      workspace: {
        findFiles: async () => [],
        asRelativePath: (uri: unknown) => String(uri),
        createFileSystemWatcher: () => {
          throw new Error("watcher disabled in the sanity harness");
        },
      },
    } as never,
    rootUri: { path: "/" } as never,
    workspace: workspace.reader,
    listWorkspacePaths: async () => [...workspace.files.keys()],
    writable,
    watch: false,
  });
}

const workspace = createFakeWorkspace();
const fs = await createFs(workspace, true);
const contributedCommand = registerTerminalCommand({
  name: "hello",
  async execute(args) {
    return {
      stdout: `hello ${args[0] ?? "world"}\n`,
      stderr: "",
      exitCode: 0,
    };
  },
});

const nodeCalls: Array<{
  entry: string;
  cwd?: string;
  argv?: string[];
  fsCache?: string;
}> = [];
const shellOutput = createShellOutput();
const streamed: string[] = [];

shellOutput.bind((data) => streamed.push(data));

const commands = await createShellCommands({
  vscode: {} as never,
  rootUri: {} as never,
  fs,
  level: "workspace",
  output: shellOutput,
  engine: async () => ({
    runFile: async () => 0,
    runProgram: async (entry, options) => {
      nodeCalls.push({ entry, cwd: options?.cwd, argv: options?.argv, fsCache: options?.fsCache });
      options?.stdout?.("node-ok\n");

      return 0;
    },
    dispose() {},
  }),
});
const shell = createShellSession({ fs, commands });

assert.equal((await shell.exec("cat src/a.ts")).stdout, "export const a = 1;\n");
assert.match((await shell.exec("ls src")).stdout, /a\.ts/);

await shell.exec("echo hello > src/new.txt");
assert.equal(new TextDecoder().decode(workspace.files.get("src/new.txt")), "hello\n");

await shell.exec("mkdir -p made/deep");
assert.ok(workspace.dirs.has("made/deep"));

await shell.exec("cp src/new.txt made/deep/copy.txt");
assert.ok(workspace.files.has("made/deep/copy.txt"));

await shell.exec("mv made/deep/copy.txt made/moved.txt");
assert.ok(workspace.files.has("made/moved.txt"));
assert.ok(!workspace.files.has("made/deep/copy.txt"));

assert.match((await shell.exec("echo src/*.ts")).stdout, /src\/a\.ts/);

await shell.exec("rm -rf made");
assert.ok(!workspace.dirs.has("made"));
assert.ok(!workspace.files.has("made/moved.txt"));

assert.equal((await shell.exec("npm run hello")).stdout, "hi\n");
assert.equal((await shell.exec("hello OpenAI")).stdout, "hello OpenAI\n");
assert.match((await shell.exec("node --version")).stdout, /v20/);
assert.match((await shell.exec("npm --version")).stdout, /10\./);

await shell.exec("cd src && pwd");
assert.equal(shell.cwd, "/src");

assert.equal((await shell.exec("node scripts/build.ts one two")).stdout, "node-ok\n");
assert.deepEqual(nodeCalls.at(-1), {
  entry: "scripts/build.ts",
  cwd: "/src",
  argv: ["one", "two"],
  fsCache: "lazy",
});

assert.equal((await shell.exec("node --eager scripts/build.ts one")).stdout, "node-ok\n");
assert.deepEqual(nodeCalls.at(-1), {
  entry: "scripts/build.ts",
  cwd: "/src",
  argv: ["one"],
  fsCache: "eager",
});

assert.equal((await shell.exec("node --lazy scripts/build.ts")).stdout, "node-ok\n");
assert.equal(nodeCalls.at(-1)?.fsCache, "lazy");

assert.match((await shell.exec("npx --version")).stdout, /10\./);
assert.equal((await shell.exec("npx -p tiny-cli tinycli one two")).stdout, "node-ok\n");
assert.deepEqual(nodeCalls.at(-1), {
  entry: "/node_modules/tiny-cli/bin/tiny.js",
  cwd: "/src",
  argv: ["one", "two"],
  fsCache: "lazy",
});
assert.equal((await shell.exec("npx tiny one")).stdout, "node-ok\n");
assert.equal(nodeCalls.at(-1)?.entry, "/node_modules/tiny/cli.js");
assert.equal((await shell.exec("npx --no-install missing-pkg")).exitCode, 1);

shellOutput.setStreaming(true);

const streamedResult = await shell.exec("node scripts/build.ts");

assert.equal(streamedResult.stdout, "");
assert.equal(streamed.join(""), "node-ok\n");

shellOutput.setStreaming(false);

await shell.exec("echo scratch > /tmp/note.txt");
assert.ok(!workspace.files.has("tmp/note.txt"));
assert.equal(await fs.readFile("/tmp/note.txt"), "scratch\n");

/*
 * Some providers return an empty/undefined root listing even though files
 * resolve. The shell must fall back to the workspace path scan for `ls /`.
 */
const hiddenRoot = createFakeWorkspace();
const originalReaddir = hiddenRoot.reader.readDirectory.bind(hiddenRoot.reader);

hiddenRoot.reader.readDirectory = async (path) => (path === "" ? undefined : originalReaddir(path));

const hiddenRootShell = createShellSession({ fs: await createFs(hiddenRoot, true) });

assert.match((await hiddenRootShell.exec("ls /")).stdout, /src/);
assert.match((await hiddenRootShell.exec("ls src")).stdout, /a\.ts/);

const readOnly = createShellSession({ fs: await createFs(workspace, false) });
await assert.rejects(readOnly.exec("echo nope > src/nope.txt"));
assert.ok(!workspace.files.has("src/nope.txt"));
assert.equal((await readOnly.exec("echo ok > /tmp/ok.txt")).exitCode, 0);

contributedCommand.dispose();

console.log("terminal shell sanity: ok");
