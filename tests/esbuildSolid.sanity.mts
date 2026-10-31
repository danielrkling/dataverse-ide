/*
 * Solid Babel esbuild-plugin sanity harness (manual).
 *
 * Run:
 *   npx esbuild tests/esbuildSolid.sanity.mts --bundle --platform=node --format=esm
 *     --external:@babel/* --external:@solidjs/babel-plugin --external:babel-preset-solid
 *     --outfile=tmp-esbuild-solid-sanity.mjs
 *   node tmp-esbuild-solid-sanity.mjs
 *
 * Verifies, through src/extensions/esbuild/solidPlugin.ts + real esbuild:
 *   1. "v2" compiles workspace .tsx (and strips TS) with @solidjs/babel-plugin
 *   2. "v1" compiles the same shape with babel-preset-solid
 *   3. source maps chain (Babel's inline map -> esbuild .js.map)
 *   4. Solid 2.0 diagnostics come back as attributed esbuild errors
 */
import assert from "node:assert/strict";
import * as path from "node:path";

import * as esbuild from "esbuild";

import { createSolidEsbuildPlugin } from "../src/extensions/esbuild/solidPlugin.ts";

const FILES: Record<string, string> = {
  "src/index.tsx": [
    "import { render } from RUNTIME;",
    "import { Greeting } from './greeting';",
    "const root = document.getElementById('root');",
    "export default () => render(() => <Greeting name='esbuild' />, root!);",
  ].join("\n"),
  "src/greeting.tsx": [
    "import { suffix } from './suffix';",
    "interface GreetingProps { name: string }",
    "export function Greeting(props: GreetingProps) {",
    "  return <div class='greeting'>Hello {props.name}{suffix}</div>;",
    "}",
  ].join("\n"),
  "src/suffix.ts": 'export const suffix = "!";',
};

function runtimeFor(version: "v1" | "v2"): string {
  return JSON.stringify(version === "v2" ? "@solidjs/web" : "solid-js/web");
}

function sourceFiles(version: "v1" | "v2"): Record<string, string> {
  return Object.fromEntries(
    Object.entries(FILES).map(([file, source]) => [
      file,
      source.replace("RUNTIME", runtimeFor(version)),
    ]),
  );
}

/*
 * Minimal stand-in for the real workspace-fs plugin: resolve relative
 * imports inside the fixture map and load plain TS/JS files (the Solid plugin
 * owns .jsx/.tsx loads and is registered first, so esbuild tries it first).
 */
function createWorkspacePlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "test-workspace",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: path.posix.normalize(args.path), namespace: "workspace" };
        }

        if (!args.path.startsWith(".")) {
          return undefined;
        }

        const directory = path.posix.dirname(args.importer);
        const base = path.posix.normalize(path.posix.join(directory, args.path));

        for (const extension of ["", ".tsx", ".ts", ".jsx", ".js"]) {
          const candidate = base + extension;

          if (files[candidate] != null) {
            return { path: candidate, namespace: "workspace" };
          }
        }

        return undefined;
      });

      build.onLoad({ filter: /\.[jt]sx?$/, namespace: "workspace" }, (args) => ({
        contents: files[args.path],
        loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".ts") ? "ts" : "js",
      }));
    },
  };
}

async function build(
  version: "v1" | "v2",
  options?: { sourcemap?: boolean; files?: Record<string, string> },
): Promise<esbuild.BuildResult> {
  const files = options?.files ?? sourceFiles(version);

  return esbuild.build({
    entryPoints: ["src/index.tsx"],
    bundle: true,
    write: false,
    outdir: "out",
    format: "esm",
    platform: "browser",
    logLevel: "silent",
    sourcemap: options?.sourcemap ?? false,
    target: "es2022",
    external: version === "v2" ? ["@solidjs/web"] : ["solid-js/web"],
    plugins: [
      createSolidEsbuildPlugin({
        version,
        readText: async (file) => files[file],
        sourcemap: options?.sourcemap,
      }),
      createWorkspacePlugin(files),
    ],
  });
}

function jsOutput(result: esbuild.BuildResult): string {
  const output = result.outputFiles?.find((file) => file.path.endsWith(".js"));

  assert.ok(
    output != null,
    `bundle produced a .js output (errors: ${JSON.stringify(
      result.errors,
    )}; outputs: ${(result.outputFiles ?? []).map((file) => file.path).join(", ")})`,
  );

  return output.text;
}

async function main(): Promise<void> {
  /* 1. Solid 2.x through @solidjs/babel-plugin. */
  const v2 = await build("v2", { sourcemap: true });
  const v2Output = jsOutput(v2);

  assert.ok(v2Output.includes("template("), "v2 emits a DOM template");
  assert.ok(v2Output.includes("@solidjs/web"), "v2 keeps the @solidjs/web import");
  assert.ok(!/interface GreetingProps|: GreetingProps/.test(v2Output), "v2 strips TypeScript");
  assert.ok(!/jsxDEV|jsx\(/.test(v2Output), "v2 leaves no JSX runtime behind");

  const v2MapFile = v2.outputFiles?.find((file) => file.path.endsWith(".js.map"));
  assert.ok(v2MapFile != null, "v2 build emits a source map");

  const v2Map = JSON.parse(v2MapFile.text) as { sources: string[]; sourcesContent?: string[] };
  assert.ok(
    v2Map.sources.some((source) => source.includes("greeting")),
    `v2 map points back at the original TSX (sources: ${v2Map.sources.join(", ")})`,
  );
  assert.ok(
    v2Map.sourcesContent?.some((content) => content?.includes("interface GreetingProps")),
    "v2 map carries the original TypeScript source",
  );

  console.log(
    `1. solid v2 build OK (${v2Output.length} chars, map sources: ${v2Map.sources.length})`,
  );

  /* 2. Solid 1.x through babel-preset-solid. */
  const v1 = await build("v1");
  const v1Output = jsOutput(v1);

  assert.ok(v1Output.includes("template("), "v1 emits a DOM template");
  assert.ok(v1Output.includes("solid-js/web"), "v1 keeps the solid-js/web import");
  assert.ok(!/interface GreetingProps|: GreetingProps/.test(v1Output), "v1 strips TypeScript");
  assert.ok(!/jsxDEV|jsx\(/.test(v1Output), "v1 leaves no JSX runtime behind");

  console.log(`2. solid v1 build OK (${v1Output.length} chars)`);

  /* 3. Solid 2.0 compile errors surface as attributed esbuild errors. */
  let removed: esbuild.BuildResult;

  try {
    removed = await build("v2", {
      files: {
        "src/index.tsx":
          'import { render } from "@solidjs/web";\nrender(() => <li classList={{ active: true }} />, document.body);\n',
      },
    });
  } catch (error) {
    /* esbuild rejects the promise when a plugin reports errors. */
    removed = {
      errors: (error as { errors?: esbuild.Message[] }).errors ?? [],
    } as esbuild.BuildResult;
  }

  assert.equal(removed.errors.length, 1, "one compile error reported");
  assert.match(removed.errors[0]!.text, /^\[solid:v2\]/);
  assert.match(removed.errors[0]!.text, /classList/);
  assert.ok(
    !removed.errors[0]!.text.includes("C:\\"),
    "absolute Babel filename prefix is stripped from the message",
  );

  console.log(`3. solid v2 error attribution OK: ${removed.errors[0]!.text.split("\n")[0]}`);

  console.log("4. esbuild solid plugin sanity: ALL OK");
}

await main();
