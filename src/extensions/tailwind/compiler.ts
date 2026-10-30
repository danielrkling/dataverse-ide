/*
 * Tailwind workspace compiler.
 *
 * Uses Tailwind v4's compile() API and scans workspace source files for
 * likely utility candidates.
 *
 * The prior implementation collected a large in-memory workspace/module map
 * and used esbuild worker lazy-resolution probe rounds for @plugin modules.
 *
 * The current implementation uses the main-thread esbuild compiler's direct
 * vscode.workspace.fs resolver instead:
 *
 * - workspace source files are read only while scanning candidates
 * - Tailwind @plugin modules are bundled through EsbuildBuildRunner
 * - package resolution reads package.json/module files directly as needed
 * - no node_modules collection or lazyBuild probe loop is required
 */

import { compile } from "tailwindcss";

import tailwindIndexCss from "tailwindcss/index.css?raw";
import tailwindPreflightCss from "tailwindcss/preflight.css?raw";
import tailwindThemeCss from "tailwindcss/theme.css?raw";

import type * as vscodeType from "vscode";

import { EsbuildBuildRunner } from "../esbuild/buildRunner.js";

/*
 * Workspace source scanning
 */

const SCANNABLE_EXTENSIONS =
  /\.(html|htm|vue|svelte|astro|xhtml|md|mdx|txt|ts|tsx|mts|cts|jsx|js|mjs|cjs|css|scss|less|sass|php|json|jsonc|yaml|yml|toml)$/i;

/*
 * Any quoted string: '…', "…", `…`. Template literals are intentionally
 * included: invalid candidates are ignored safely by Tailwind.
 */
const STRING_CAPTURE_PATTERN = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/* Unquoted class attribute values, e.g. class=flex or className={styles.x}. */
const UNQUOTED_CLASS_PATTERN = /\bclass(?:Name)?\s*=\s*([^\s"'`>]+)/g;

const DEFAULT_CSS_INPUT = '@import "tailwindcss";';

const MAX_SCANNED_FILES = 4000;
const MAX_TOKENS_PER_FILE = 20000;
const MAX_CANDIDATE_LENGTH = 256;

const CANDIDATE_SHAPE = /^[a-zA-Z0-9_![\]().,#%$@&*:+-]+$/;

const BUNDLED_STYLESHEETS: Record<string, string> = {
  tailwindcss: tailwindIndexCss,
  "tailwindcss/index.css": tailwindIndexCss,
  "tailwindcss/preflight.css": tailwindPreflightCss,
  "tailwindcss/preflight": tailwindPreflightCss,
  "tailwindcss/theme.css": tailwindThemeCss,
  "tailwindcss/theme": tailwindThemeCss,
  "tailwindcss/utilities.css": "@tailwind utilities;",
  "tailwindcss/utilities": "@tailwind utilities;",
};

export type TailwindCompileResult = {
  css: string;

  /**
   * Signature of the CSS input, compiled @plugin module text, and extracted
   * candidate set. Used by watch mode to skip no-op rebuilds.
   */
  signature: string;

  candidateCount: number;
};

/*
 * Scan cache: unchanged files reuse prior candidate extraction.
 */
const scanCache = new Map<
  string,
  {
    mtime: number;
    candidates: string[];
  }
>();

function extractCandidates(text: string): string[] {
  const candidates: string[] = [];

  const addToken = (raw: string): void => {
    if (candidates.length >= MAX_TOKENS_PER_FILE) {
      return;
    }

    const candidate = raw
      .replace(/^[\s"'`,;:(){}<>=]+/, "")
      .replace(/[\s"'`,;:(){}<>=]+$/, "");

    if (
      candidate.length === 0 ||
      candidate.length > MAX_CANDIDATE_LENGTH ||
      !CANDIDATE_SHAPE.test(candidate) ||
      !/[a-zA-Z]/.test(candidate) ||
      candidate.startsWith("$")
    ) {
      return;
    }

    candidates.push(candidate);
  };

  for (const pattern of [STRING_CAPTURE_PATTERN, UNQUOTED_CLASS_PATTERN]) {
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) != null) {
      const rawValue = match[2] ?? match[1];

      for (const token of rawValue.split(/\s+/)) {
        addToken(token);
      }
    }
  }

  return candidates;
}

async function scanWorkspaceCandidates(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<Set<string>> {
  const uris = await vscode.workspace.findFiles(
    "**/*",
    "{**/node_modules/**,**/.git/**,**/.ide-build/**,**/dist/**,**/out/**}",
    MAX_SCANNED_FILES,
  );

  const candidates = new Set<string>();

  for (const uri of uris) {
    if (!SCANNABLE_EXTENSIONS.test(uri.path)) {
      continue;
    }

    let mtime: number;

    try {
      mtime = (await vscode.workspace.fs.stat(uri)).mtime;
    } catch {
      continue;
    }

    const cached = scanCache.get(uri.path);

    if (cached != null && cached.mtime === mtime) {
      for (const candidate of cached.candidates) {
        candidates.add(candidate);
      }

      continue;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);

      const extracted = extractCandidates(text);

      scanCache.set(uri.path, {
        mtime,
        candidates: extracted,
      });

      for (const candidate of extracted) {
        candidates.add(candidate);
      }
    } catch {
      /*
       * Binary and unreadable files are irrelevant to class scanning.
       */
    }
  }

  return candidates;
}

/*
 * Tailwind stylesheet loading
 */

function normalizeBase(base: string): string {
  return (base || "/").replaceAll("\\", "/");
}

function joinWorkspacePath(base: string, id: string): string {
  const cleanBase = normalizeBase(base)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  const cleanId = id
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");

  if (cleanBase.length === 0) {
    return cleanId;
  }

  if (cleanId.startsWith("/")) {
    return cleanId.replace(/^\/+/, "");
  }

  return `${cleanBase}/${cleanId}`;
}

function createLoadStylesheet(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
) {
  return async (
    id: string,
    base: string,
  ): Promise<{
    path: string;
    base: string;
    content: string;
  }> => {
    const bundled = BUNDLED_STYLESHEETS[id];

    if (bundled != null) {
      return {
        path: `virtual:tailwindcss/${id}`,
        base: "/",
        content: bundled,
      };
    }

    if (id.startsWith("http://") || id.startsWith("https://")) {
      const response = await fetch(id);

      if (!response.ok) {
        throw new Error(`Failed to fetch stylesheet: ${id}`);
      }

      return {
        path: id,
        base,
        content: await response.text(),
      };
    }

    const path = joinWorkspacePath(base, id);

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(rootUri, ...path.split("/")),
      );

      return {
        path,
        base: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/",
        content: new TextDecoder().decode(bytes),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Could not load stylesheet "${id}" (${path}): ${message}`,
      );
    }
  };
}

/*
 * Tailwind @plugin and @config module loading
 *
 * Bare module specifiers are wrapped in a small virtual ESM entry:
 *
 *   import plugin from "@tailwindcss/forms";
 *   export default plugin;
 *
 * Esbuild's direct workspace filesystem resolver then reads package.json and
 * package source files from node_modules as necessary.
 */

const VIRTUAL_PLUGIN_ENTRY = "__tailwind-plugin-entry__.mjs";

type TailwindLoadModule = NonNullable<
  NonNullable<Parameters<typeof compile>[1]>["loadModule"]
>;

type TailwindModule = Awaited<ReturnType<TailwindLoadModule>>["module"];

function toPluginImportEntry(moduleSpecifier: string): string {
  const escapedSpecifier = moduleSpecifier
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');

  return [
    `import plugin from "${escapedSpecifier}";`,
    "export default plugin;",
    "",
  ].join("\n");
}

async function bundleAndImportModule(
  runner: EsbuildBuildRunner,
  entry: string,
  virtualFiles?: Record<string, string>,
): Promise<{
  module: unknown;
  text: string;
}> {
  const response = await runner.build({
    entry,
    virtualFiles,
    bundle: true,
    format: "esm",
    minify: false,
    sourcemap: false,
  });

  if (!response.ok) {
    throw new Error(
      `Bundling Tailwind module "${entry}" failed: ${response.error}`,
    );
  }

  for (const warning of response.warnings) {
    if (warning.includes("left external")) {
      throw new Error(
        `Tailwind module "${entry}" has an unresolved dependency: ${warning}`,
      );
    }
  }

  const bundle = response.outputs.find((output) => output.path.endsWith(".js"));

  if (bundle == null) {
    throw new Error(
      `Bundling Tailwind module "${entry}" produced no JavaScript output.`,
    );
  }

  const blobUrl = URL.createObjectURL(
    new Blob([bundle.text], {
      type: "text/javascript",
    }),
  );

  try {
    const module = await import(blobUrl).catch((error: unknown) => {
      throw new Error(
        `Importing bundled Tailwind module "${entry}" failed: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Bundle head: ${bundle.text.slice(0, 400)}`,
      );
    });

    return {
      module,
      text: bundle.text,
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function createLoadModule(
  rootUri: vscodeType.Uri,
  runner: EsbuildBuildRunner | undefined,
  pluginInputs: string[],
): TailwindLoadModule {
  return async (
    id: string,
    base: string,
  ): Promise<{
    path: string;
    base: string;
    module: TailwindModule;
  }> => {
    if (id.startsWith("http://") || id.startsWith("https://")) {
      const module = await import(/* @vite-ignore */ id);

      return {
        path: id,
        base,
        module: (module.default ?? module) as TailwindModule,
      };
    }

    if (runner == null) {
      throw new Error(
        `Cannot load @plugin "${id}": the esbuild compiler is unavailable.`,
      );
    }

    const cacheKey = `${id}\u0000${base}`;

    const bundled =
      !id.startsWith(".") && !id.startsWith("/")
        ? await bundleAndImportModule(
            runner,
            VIRTUAL_PLUGIN_ENTRY,
            {
              [VIRTUAL_PLUGIN_ENTRY]: toPluginImportEntry(id),
            },
          )
        : await bundleAndImportModule(
            runner,
            joinWorkspacePath(base, id),
          );

    /*
     * Include the generated bundle text in the Tailwind output signature.
     * Editing an @plugin module or any resolved dependency therefore causes
     * watch mode to produce a new CSS output.
     */
    pluginInputs.push(`${cacheKey}\u0000${bundled.text}`);

    const rawModule = bundled.module as
      | {
          default?: unknown;
        }
      | ((...args: unknown[]) => unknown)
      | null;

    const pluginModule =
      typeof rawModule === "function"
        ? rawModule
        : (rawModule?.default ?? rawModule);

    return {
      path:
        id.startsWith(".") || id.startsWith("/")
          ? joinWorkspacePath(base, id)
          : id,
      base,
      module: pluginModule as TailwindModule,
    };
  };
}

export async function compileTailwindCss(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: {
    input?: string;
    pluginRunner?: EsbuildBuildRunner;
    minify?: boolean;
    outputChannel?: vscodeType.OutputChannel;
  } = {},
): Promise<TailwindCompileResult> {
  const inputPath = options.input;

  let cssInput = DEFAULT_CSS_INPUT;
  let base = "/";

  if (inputPath != null && inputPath.trim().length > 0) {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(rootUri, ...inputPath.split("/")),
      );

      cssInput = new TextDecoder().decode(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Could not read the Tailwind input stylesheet "${inputPath}": ${message}. ` +
          'Create the file, or remove "input" from tailwind.config.json to use the default (@import "tailwindcss").',
      );
    }

    base = inputPath.includes("/")
      ? inputPath.slice(0, inputPath.lastIndexOf("/"))
      : "/";
  }

  const candidates = await scanWorkspaceCandidates(vscode, rootUri);

  const pluginInputs: string[] = [];

  const compiler = await compile(cssInput, {
    base,
    loadStylesheet: createLoadStylesheet(vscode, rootUri),
    loadModule: createLoadModule(
      rootUri,
      options.pluginRunner,
      pluginInputs,
    ),
  });

  const css = compiler.build([...candidates]);

  let finalCss = css;

  if (options.minify === true) {
    if (options.pluginRunner == null) {
      throw new Error(
        "Cannot minify Tailwind CSS: the esbuild compiler is unavailable.",
      );
    }

    const response = await options.pluginRunner.transform({
      filename: "tailwind.css",
      source: css,
      minify: true,
    });

    if (!response.ok) {
      throw new Error(`CSS minification failed: ${response.error}`);
    }

    const minified = response.outputs[0]?.text;

    if (minified == null) {
      throw new Error("CSS minification produced no output.");
    }

    finalCss = minified;
  }

  const signature = [
    cssInput,
    ...pluginInputs,
    [...candidates].sort().join("\u0001"),
  ].join("\u0000");

  return {
    css: finalCss,
    signature,
    candidateCount: candidates.size,
  };
}