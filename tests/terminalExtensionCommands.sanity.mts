/*
 * Sanity harness for the extension-contributed shell commands
 * (tailwind, dataverse, flatten).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/terminalExtensionCommands.sanity.mts --bundle \
 *     --platform=node --format=esm --outfile=.tmp-terminal-ext.mjs
 *   node .tmp-terminal-ext.mjs
 *   rm .tmp-terminal-ext.mjs
 */

import assert from "node:assert/strict";

import { registerDataverseTerminalCommands } from "../src/extensions/dataverse/terminal.ts";
import { registerFlattenTerminalCommands } from "../src/extensions/flatten/terminal.ts";
import { registerTailwindTerminalCommands } from "../src/extensions/tailwind/terminal.ts";
import { getTerminalCommandContributions } from "../src/extensions/terminal/registry.ts";
import type { CommandContext } from "just-bash";

type Call = { command: string; args: unknown[] };

const calls: Call[] = [];

function uri(path: string) {
  return { scheme: "file", path: `/${path.replace(/^\/+/, "")}`, toString: () => path } as never;
}

const vscode = {
  Uri: {
    joinPath(root: { path: string }, ...parts: string[]) {
      return uri([root.path, ...parts].join("/").replace(/\/+/g, "/"));
    },
  },
  workspace: {
    getConfiguration() {
      return {
        get(_key: string, fallback: unknown) {
          return fallback;
        },
      };
    },
    fs: {
      async readFile() {
        throw new Error("missing");
      },
    },
  },
  commands: {
    async executeCommand(command: string, ...args: unknown[]) {
      calls.push({ command, args });

      switch (command) {
        case "dataverseIde.tailwind.compileCss":
          return true;

        case "dataverseIde.flatten.selected":
        case "dataverseIde.flatten.configured":
          return "#src#1.md";

        case "dataverseIde.dataverse.uploadConfiguredFiles":
        case "dataverseIde.dataverse.uploadSelection":
          return { files: 2, uploaded: 2, failures: [] };

        case "dataverseIde.dataverse.uploadActiveFile":
          return { files: 1, uploaded: 0, failures: ["boom"] };

        default:
          return undefined;
      }
    },
  },
} as never;

const rootUri = { path: "/workspace" } as never;
const ctx = {
  cwd: "/src",
  fs: {
    resolvePath(cwd: string, target: string) {
      if (target.startsWith("/")) {
        return target;
      }

      const parts = `${cwd}/${target}`.split("/").filter(Boolean);
      const segments: string[] = [];

      for (const part of parts) {
        if (part === ".") {
          continue;
        }

        if (part === "..") {
          segments.pop();
          continue;
        }

        segments.push(part);
      }

      return `/${segments.join("/")}`;
    },
  },
} as unknown as CommandContext;

const disposables = [
  registerTailwindTerminalCommands(vscode, rootUri),
  registerDataverseTerminalCommands(vscode, rootUri),
  registerFlattenTerminalCommands(vscode, rootUri),
];

const contributions = new Map(
  getTerminalCommandContributions().map((contribution) => [contribution.name, contribution]),
);

async function run(name: string, args: string[]) {
  const contribution = contributions.get(name);

  assert.ok(contribution != null, `missing command: ${name}`);

  return contribution.execute(args, ctx, {} as never);
}

try {
  let result = await run("tailwind", []);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /compiled dist\/tailwind\.css/);

  result = await run("tailwind", ["watch"]);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.at(-1)?.command, "dataverseIde.tailwind.startWatch");

  result = await run("tailwind", ["nope"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown command/);

  result = await run("flatten", ["a.ts", "sub/b.txt"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /#src#1\.md/);

  const flattenCall = calls.at(-1);

  assert.equal(flattenCall?.command, "dataverseIde.flatten.selected");
  assert.deepEqual(
    (flattenCall?.args[0] as Array<{ path: string }>).map((entry) => entry.path),
    ["/workspace/src/a.ts", "/workspace/src/sub/b.txt"],
  );

  result = await run("flatten", ["--configured"]);
  assert.equal(result.exitCode, 0);
  assert.equal(calls.at(-1)?.command, "dataverseIde.flatten.configured");

  result = await run("flatten", ["--wat"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown option/);

  result = await run("dataverse", ["upload"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /2 of 2 web resource/);

  result = await run("dataverse", ["upload", "dist/index.html"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    (calls.at(-1)?.args[0] as Array<{ path: string }>).map((entry) => entry.path),
    ["/workspace/src/dist/index.html"],
  );

  result = await run("dataverse", ["upload-active"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /1 upload\(s\) failed/);

  result = await run("dataverse", ["schema", "nope"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /unknown schema action/);

  console.log("terminal extension commands sanity: ok");
} finally {
  for (const disposable of disposables) {
    disposable.dispose();
  }
}
