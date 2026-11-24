/*
 * Main-thread esbuild compiler and workspace filesystem resolver.
 *
 * This replaces the earlier worker-only in-memory-file-map compiler path.
 * It reads source files directly through vscode.workspace.fs, which means:
 *
 * - no workspace-wide source collection
 * - no node_modules manifest scan
 * - no lazy probe/rebuild rounds
 * - no Worker postMessage copies of workspace content
 *
 * The resolver supports:
 *
 * - relative imports
 * - workspace-root-relative imports
 * - npm package imports from node_modules
 * - scoped packages and package subpaths
 * - package.json exports/imports maps
 * - conditional browser/import/module/default/require exports
 * - configured externals
 * - Node builtins left external
 * - optional virtual source files for callers such as Tailwind @plugin
 *
 * Builds can run through a reusable `EsbuildBuildSession` (context + rebuild)
 * so watch mode keeps esbuild's incremental graph. Each rebuild still gets a
 * fresh workspace reader, so edits are never served from a stale build cache.
 */

import * as esbuild from "esbuild-wasm";
import esbuildWasmGzipUrl from "virtual:esbuild-wasm-gzip-url";
import picomatch from "picomatch";

import type * as vscodeType from "vscode";

import {
  NODE_BUILTINS,
  normalizePath,
  parseJsonSafe,
  splitPackageSpec,
} from "../shared/packageResolver.js";

import { createSolidEsbuildPlugin, type SolidCompilerVersion } from "./solidPlugin.js";

export type BuildOutputFile = {
  /** Workspace-relative destination path. */
  path: string;
  /** Raw output bytes (JavaScript, CSS, source maps, or copied assets). */
  contents: Uint8Array;
  /** UTF-8 view used by callers that need to inspect JavaScript text. */
  text: string;
};

/** One esbuild entry point: a path or an esbuild `{ in, out }` pair. */
export type EntryPoint = string | { in: string; out?: string };

export type WorkspaceEntryKind = "file" | "directory";

/**
 * Per-build filesystem counters. Reported by the runner so slow builds can be
 * diagnosed without opening devtools.
 */
export type WorkspaceReaderStats = {
  fileReads: number;
  fileReadCacheHits: number;
  directoryReads: number;
  directoryReadCacheHits: number;
};

export type WorkspaceReader = {
  /**
   * Reads a workspace-relative file as bytes. Returns undefined when the file
   * does not exist or cannot be read.
   */
  readBytes: (path: string) => Promise<Uint8Array | undefined>;

  /**
   * Reads a workspace-relative UTF-8 text file. Returns undefined when the
   * file does not exist or cannot be read.
   */
  readText: (path: string) => Promise<string | undefined>;

  /**
   * Lists a workspace-relative directory. Returns undefined when the reader
   * cannot list directories (the resolver then falls back to direct probes).
   *
   * This is the difference between one filesystem round trip per directory
   * and one per *candidate extension*: extensionless imports used to probe up
   * to 20 paths each through vscode.workspace.fs.
   */
  readDir?: (path: string) => Promise<Map<string, WorkspaceEntryKind> | undefined>;

  /** Mutable counters for this reader (when the reader tracks them). */
  readonly stats?: WorkspaceReaderStats;
};

export type BuildRequest = {
  id: number;
  type: "build";

  /**
   * Workspace-relative or virtual entry points. All entries are compiled by
   * one esbuild pass, so shared imports and code-split chunks are linked
   * together.
   */
  entries: EntryPoint[];

  /**
   * The workspace-backed reader is intentionally not serializable. This
   * compiler runs on the main thread, so plugins can read the real mounted
   * workspace directly.
   */
  workspace: WorkspaceReader;

  /**
   * Optional ephemeral source files layered over workspace files for one
   * build. This supports generated entry modules without writing temporary
   * files into the user's workspace.
   *
   * Example:
   *
   * {
   *   "__tailwind-plugin-entry__.mjs":
   *     'import plugin from "@tailwindcss/forms"; export default plugin;'
   * }
   */
  virtualFiles?: Record<string, string>;

  format?: "esm" | "iife" | "cjs";
  platform?: "browser" | "node" | "neutral";
  charset?: "ascii" | "utf8";
  globalName?: string;

  minify?: boolean;
  sourcemap?: boolean | "linked" | "inline" | "external" | "both";
  sourceRoot?: string;
  sourcesContent?: boolean;

  target?: string | string[];
  treeShaking?: boolean;
  keepNames?: boolean;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
  lineLimit?: number;
  drop?: ("console" | "debugger")[];
  pure?: string[];

  jsx?: "transform" | "preserve" | "automatic";
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  jsxDev?: boolean;
  jsxSideEffects?: boolean;

  bundle?: boolean;
  splitting?: boolean;
  external?: string[];
  alias?: Record<string, string>;
  define?: Record<string, string>;
  /** Extension -> esbuild loader overrides, e.g. { ".png": "dataurl" }. */
  loader?: Record<string, string>;
  inject?: string[];
  tsconfig?: string;
  tsconfigRaw?: string | Record<string, unknown>;

  conditions?: string[];
  mainFields?: string[];
  resolveExtensions?: string[];
  nodePaths?: string[];
  packages?: "bundle" | "external";

  outdir?: string;
  outfile?: string;
  outbase?: string;
  entryNames?: string;
  chunkNames?: string;
  assetNames?: string;
  publicPath?: string;
  outExtension?: Record<string, string>;
  allowOverwrite?: boolean;

  minifyWhitespace?: boolean;
  minifyIdentifiers?: boolean;
  minifySyntax?: boolean;
  ignoreAnnotations?: boolean;
  dropLabels?: string[];
  mangleProps?: string;
  reserveProps?: string;
  supported?: Record<string, boolean>;
  banner?: string | { js?: string; css?: string };
  footer?: string | { js?: string; css?: string };

  /**
   * Solid JSX compiler backend:
   *
   *   "off" - leave JSX/TSX to esbuild's configured JSX mode
   *   "v1"  - babel-preset-solid (Solid 1.x)
   *   "v2"  - @solidjs/babel-plugin (Solid 2.x)
   */
  solid?: SolidCompilerVersion | "off";
};

export type TransformRequest = {
  id: number;
  type: "transform";
  filename: string;
  source: string;
  minify?: boolean;
};

export type BuildSuccessResponse = {
  id: number;
  ok: true;
  outputs: BuildOutputFile[];
  warnings: string[];
  /**
   * Workspace-relative files in the build's dependency graph (workspace
   * sources plus node_modules modules). Watch mode uses this set to ignore
   * unrelated filesystem writes.
   */
  dependencies: string[];
};

export type BuildFailureResponse = {
  id: number;
  ok: false;
  error: string;
  /**
   * Paths resolution reached before the failure. Watch can keep rebuilding
   * when one of them changes, so a newly-added broken file can be fixed
   * without editing its importer again.
   */
  dependencies?: string[];
};

export type BuildResponse = BuildSuccessResponse | BuildFailureResponse;

type PackageJson = Record<string, unknown>;

type PackageResolver = {
  resolveBareImport: (
    specifier: string,
    kind: string,
    depth?: number,
  ) => Promise<string | undefined>;
  resolvePackageImport: (
    specifier: string,
    importer: string,
    kind: string,
    depth?: number,
  ) => Promise<string | undefined>;
  applyBrowserSpecifierMapping: (
    specifier: string,
    importer: string,
    kind: string,
    depth: number,
  ) => Promise<string | undefined | false>;
  applyBrowserFileMapping: (
    path: string,
    kind: string,
    depth: number,
  ) => Promise<string | undefined | false>;
  sideEffectsFor: (path: string) => Promise<boolean | undefined>;
};

let initialization: Promise<void> | undefined;

/*
 * Creates a cached workspace reader over vscode.workspace.fs.
 *
 * This deliberately uses vscode.workspace.fs instead of raw
 * FileSystemDirectoryHandle APIs. The mounted provider understands local
 * folders, browser workspaces, and the OPFS overlay used for node_modules.
 */
export function createWorkspaceReader(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
): WorkspaceReader {
  const fileCache = new Map<string, Promise<Uint8Array | undefined>>();
  const textCache = new Map<string, Promise<string | undefined>>();
  const directoryCache = new Map<string, Promise<Map<string, WorkspaceEntryKind> | undefined>>();

  const stats: WorkspaceReaderStats = {
    fileReads: 0,
    fileReadCacheHits: 0,
    directoryReads: 0,
    directoryReadCacheHits: 0,
  };

  const uriFor = (normalized: string): vscodeType.Uri =>
    vscode.Uri.joinPath(
      workspaceRootUri,
      ...normalized.split("/").filter((segment) => segment.length > 0),
    );

  return {
    stats,

    readBytes(path: string): Promise<Uint8Array | undefined> {
      const normalized = normalizePath(path);

      if (normalized.length === 0) {
        return Promise.resolve(undefined);
      }

      const existing = fileCache.get(normalized);

      if (existing != null) {
        stats.fileReadCacheHits++;
        return existing;
      }

      stats.fileReads++;

      const pending = (async () => {
        try {
          return await vscode.workspace.fs.readFile(uriFor(normalized));
        } catch {
          return undefined;
        }
      })();

      fileCache.set(normalized, pending);

      return pending;
    },

    readText(path: string): Promise<string | undefined> {
      const normalized = normalizePath(path);

      if (normalized.length === 0) {
        return Promise.resolve(undefined);
      }

      const existing = textCache.get(normalized);

      if (existing != null) {
        return existing;
      }

      const pending = this.readBytes(normalized).then((bytes) =>
        bytes == null ? undefined : new TextDecoder().decode(bytes),
      );

      textCache.set(normalized, pending);

      return pending;
    },

    readDir(path: string): Promise<Map<string, WorkspaceEntryKind> | undefined> {
      const normalized = normalizePath(path);
      const existing = directoryCache.get(normalized);

      if (existing != null) {
        stats.directoryReadCacheHits++;
        return existing;
      }

      stats.directoryReads++;

      const pending = (async () => {
        try {
          const entries = await vscode.workspace.fs.readDirectory(uriFor(normalized));
          const listing = new Map<string, WorkspaceEntryKind>();

          for (const [name, type] of entries) {
            listing.set(name, type === vscode.FileType.Directory ? "directory" : "file");
          }

          return listing;
        } catch {
          return undefined;
        }
      })();

      directoryCache.set(normalized, pending);

      return pending;
    },
  };
}

/*
 * Applies per-build generated sources above the actual workspace filesystem.
 * A virtual entry can import real workspace files and npm packages normally.
 */
function withVirtualFiles(
  workspace: WorkspaceReader,
  virtualFiles: Record<string, string> | undefined,
): WorkspaceReader {
  if (virtualFiles == null || Object.keys(virtualFiles).length === 0) {
    return workspace;
  }

  const normalizedVirtualFiles = new Map<string, string>();
  const virtualNamesByDirectory = new Map<string, Set<string>>();

  for (const [path, contents] of Object.entries(virtualFiles)) {
    const normalized = normalizePath(path);

    normalizedVirtualFiles.set(normalized, contents);

    const { directory, name } = splitDirectoryAndName(normalized);

    const names = virtualNamesByDirectory.get(directory) ?? new Set<string>();

    names.add(name);
    virtualNamesByDirectory.set(directory, names);
  }

  return {
    stats: workspace.stats,

    async readBytes(path: string): Promise<Uint8Array | undefined> {
      const normalized = normalizePath(path);

      const virtual = normalizedVirtualFiles.get(normalized);

      if (virtual != null) {
        return new TextEncoder().encode(virtual);
      }

      return workspace.readBytes(normalized);
    },

    async readText(path: string): Promise<string | undefined> {
      const normalized = normalizePath(path);

      const virtual = normalizedVirtualFiles.get(normalized);

      if (virtual != null) {
        return virtual;
      }

      return workspace.readText(normalized);
    },

    async readDir(path: string): Promise<Map<string, WorkspaceEntryKind> | undefined> {
      if (workspace.readDir == null) {
        return undefined;
      }

      const normalized = normalizePath(path);
      const virtualNames = virtualNamesByDirectory.get(normalized);
      const base = await workspace.readDir(normalized);

      if (virtualNames == null) {
        return base;
      }

      const listing = new Map(base ?? []);

      for (const name of virtualNames) {
        listing.set(name, "file");
      }

      return listing;
    },
  };
}

async function loadEsbuildWasm(): Promise<ArrayBuffer> {
  /*
   * The wasm binary ships as a gzip-compressed base64 .txt web resource
   * (~4.2MB) because Dataverse has no .wasm resource type and a 5MB default
   * per-file limit. DecompressionStream keeps this dependency-free.
   */
  const response = await fetch(esbuildWasmGzipUrl);

  if (!response.ok) {
    throw new Error(`Failed to load esbuild.wasm (${response.status} ${response.statusText}).`);
  }

  const compressed = Uint8Array.from(atob((await response.text()).trim()), (character) =>
    character.charCodeAt(0),
  );

  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));

  return new Response(stream).arrayBuffer();
}

async function ensureInitialized(): Promise<void> {
  if (initialization == null) {
    initialization = (async () => {
      const bytes = await loadEsbuildWasm();

      /*
       * Chrome rejects synchronous new WebAssembly.Module(...) compilation
       * for large modules on the main thread. Async compilation preserves
       * the main-thread execution model without requiring an esbuild worker.
       */
      const wasmModule = await WebAssembly.compile(bytes);

      await esbuild.initialize({
        wasmModule,
        worker: false,
      });
    })();
  }

  await initialization;
}

/**
 * Warm the shared esbuild-wasm instance.
 *
 * The node runtime calls this before installing its network guard: the wasm
 * asset is fetched over HTTP(S) on first use, so a workspace-level run that
 * transpiles TypeScript would otherwise fail with a network-permission
 * error before any user code executes.
 */
export async function ensureEsbuildCompilerReady(): Promise<void> {
  await ensureInitialized();
}

function getLoaderForPath(
  path: string,
  loaderOverrides?: Record<string, string>,
): esbuild.Loader | undefined {
  if (loaderOverrides != null) {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");

    if (dot > slash) {
      const extension = path.slice(dot).toLowerCase();
      const override = loaderOverrides[extension] ?? loaderOverrides[path.slice(dot)];

      if (override != null && override.length > 0) {
        return override as esbuild.Loader;
      }
    }
  }

  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
    return "ts";
  }

  if (path.endsWith(".tsx")) {
    return "tsx";
  }

  if (path.endsWith(".jsx")) {
    return "jsx";
  }

  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return "js";
  }

  if (path.endsWith(".css")) {
    return "css";
  }

  if (path.endsWith(".json")) {
    return "json";
  }

  /*
   * Unknown extensions fall through to esbuild's own loader selection, which
   * reports "No loader is configured" instead of silently parsing the file as
   * JavaScript.
   */
  return undefined;
}

/*
 * Determines whether an external entry matches exactly or as a package
 * prefix. This mirrors esbuild semantics:
 *
 *   external: ["lodash"]
 *
 * also externalizes:
 *
 *   lodash/fp
 */
function isConfiguredExternal(path: string, externalPaths: string[]): boolean {
  return externalPaths.some((external) => path === external || path.startsWith(`${external}/`));
}

function getImporterDirectory(importer: string): string {
  const segments = normalizePath(importer)
    .split("/")
    .filter((segment) => segment.length > 0);

  segments.pop();

  return segments.join("/");
}

function splitDirectoryAndName(path: string): {
  directory: string;
  name: string;
} {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");

  if (slash === -1) {
    return { directory: "", name: normalized };
  }

  return {
    directory: normalized.slice(0, slash),
    name: normalized.slice(slash + 1),
  };
}

function joinDirectoryAndName(directory: string, name: string): string {
  return directory.length > 0 ? `${directory}/${name}` : name;
}

const DEFAULT_RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
const EMPTY_MODULE_PATH = "__esbuild_empty_module__.js";
const BINARY_LOADERS = new Set(["binary", "file", "copy", "dataurl", "base64"]);

type BuildPlatform = "browser" | "node" | "neutral";

type TsconfigResolution = {
  /** Raw JSON/JSONC passed to esbuild for compilerOptions behavior. */
  raw?: string;
  /** Workspace-relative tsconfig path, when one was read from the workspace. */
  path?: string;
  /** Workspace-relative directory that owns the tsconfig. */
  directory: string;
  /** Workspace-relative baseUrl directory (defaults to `directory`). */
  baseUrl?: string;
  paths?: Record<string, string[]>;
};

type ResolverOptions = {
  platform: BuildPlatform;
  external: string[];
  alias: Record<string, string>;
  packages: "bundle" | "external";
  conditions?: string[];
  mainFields?: string[];
  resolveExtensions: string[];
  nodePaths: string[];
  tsconfig: TsconfigResolution;
};

/*
 * tsconfig.json uses JSONC (comments and trailing commas). esbuild accepts
 * this for tsconfigRaw, and the IDE has to parse the same text to implement
 * compilerOptions.paths/baseUrl in its workspace resolver.
 */
function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        inLineComment = false;
        output += character;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n" || character === "\r") {
        output += character;
      }
      continue;
    }

    if (inString) {
      output += character;

      if (character === "\\") {
        output += next ?? "";
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += character;
  }

  return output.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsoncSafe(text: string): Record<string, unknown> | undefined {
  return parseJsonSafe(stripJsonComments(text));
}

function directoryOf(path: string): string {
  const slash = normalizePath(path).lastIndexOf("/");

  return slash === -1 ? "" : path.replaceAll("\\", "/").slice(0, slash);
}

function joinWorkspacePath(directory: string, path: string): string {
  if (path.startsWith("/")) {
    return normalizePath(path);
  }

  return normalizePath(directory.length > 0 ? `${directory}/${path}` : path);
}

function normalizeExtensionList(extensions: readonly string[] | undefined): string[] {
  const normalized = (extensions ?? [])
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));

  return normalized.length > 0 ? normalized : DEFAULT_RESOLVE_EXTENSIONS;
}

function indexTrailsFor(extensions: readonly string[]): string[] {
  return extensions.map((extension) => `/index${extension}`);
}

function hasFileExtension(path: string): boolean {
  const basename = path.split("/").pop() ?? "";

  return basename.lastIndexOf(".") > 0;
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  );
}

function isBareSpecifier(specifier: string): boolean {
  return (
    !isRelativeSpecifier(specifier) &&
    !specifier.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(specifier)
  );
}

function applyAlias(specifier: string, alias: Record<string, string>): string {
  for (const [key, target] of Object.entries(alias)) {
    if (specifier === key) {
      return target;
    }

    if (specifier.startsWith(`${key}/`)) {
      return `${target}${specifier.slice(key.length)}`;
    }
  }

  return specifier;
}

function matchesExternal(candidate: string, patterns: readonly string[]): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;

  return patterns.some((pattern) => {
    const external = pattern.replaceAll("\\", "/");

    if (external.includes("*")) {
      const matches = picomatch(external, { dot: true });

      return matches(normalized) || matches(basename) || matches(`./${normalized}`);
    }

    if (external.startsWith(".") || external.startsWith("/")) {
      return normalized === external || normalized.endsWith(`/${external.replace(/^\.?\//, "")}`);
    }

    return normalized === external || normalized.startsWith(`${external}/`);
  });
}

function conditionsForKind(options: ResolverOptions, kind: string): Set<string> {
  const conditions = new Set<string>();

  if (options.platform === "browser") {
    conditions.add("browser");
  } else if (options.platform === "node") {
    conditions.add("node");
  }

  if (options.conditions != null) {
    for (const condition of options.conditions) {
      conditions.add(condition);
    }
  } else {
    conditions.add("module");
  }

  conditions.add(kind === "require-call" || kind === "require-resolve" ? "require" : "import");
  conditions.add("default");

  return conditions;
}

function mainFieldsFor(
  options: ResolverOptions,
  kind: string,
  packageJson: Record<string, unknown>,
): string[] {
  let fields = options.mainFields;

  if (fields == null) {
    fields =
      options.platform === "browser"
        ? ["browser", "module", "main"]
        : options.platform === "node"
          ? ["main", "module"]
          : [];
  }

  /*
   * Browser packages that provide module + main but no browser entry use
   * main for require() calls. This is esbuild's CommonJS compatibility rule.
   */
  if (
    options.platform === "browser" &&
    kind !== "import-statement" &&
    kind !== "dynamic-import" &&
    packageJson.browser == null &&
    typeof packageJson.module === "string" &&
    typeof packageJson.main === "string" &&
    fields.includes("module") &&
    fields.includes("main")
  ) {
    fields = fields.filter((field) => field !== "module");
    fields.push("module");
  }

  return fields;
}

async function readDirectoryListing(
  reader: WorkspaceReader,
  directory: string,
): Promise<Map<string, WorkspaceEntryKind> | undefined> {
  if (reader.readDir == null) {
    return undefined;
  }

  try {
    return await reader.readDir(directory);
  } catch {
    return undefined;
  }
}

/*
 * Resolves a path against a cached directory listing instead of probing every
 * candidate extension through vscode.workspace.fs.
 *
 * Before this, an extensionless import like `./components` performed up to 11
 * failed readFile round trips in the importer directory and then up to 10 more
 * `/index.*` probes. On the File System Access API provider every failure is an
 * async rejection, so a 500-module app spent most of a build in resolution.
 *
 * Falls back to the original probe strategy when a reader cannot list
 * directories (for example an unreadable directory).
 */
async function resolveWithListing(
  reader: WorkspaceReader,
  path: string,
  extensions: readonly string[],
  indexTrails: readonly string[],
): Promise<string | undefined> {
  const normalized = normalizePath(path);

  if (normalized.length === 0) {
    return undefined;
  }

  const { directory, name } = splitDirectoryAndName(normalized);
  const listing = await readDirectoryListing(reader, directory);
  const canAppendExtension = !hasFileExtension(normalized);

  if (listing != null) {
    const exact = listing.get(name);

    if (exact === "file") {
      return normalized;
    }

    if (canAppendExtension) {
      for (const extension of extensions) {
        const candidate = `${name}${extension}`;

        if (listing.get(candidate) === "file") {
          return joinDirectoryAndName(directory, candidate);
        }
      }
    }

    if (exact === "directory") {
      const nested = await readDirectoryListing(reader, normalized);

      if (nested != null) {
        for (const trail of indexTrails) {
          const indexName = trail.replace(/^\/+/, "");

          if (nested.get(indexName) === "file") {
            return joinDirectoryAndName(normalized, indexName);
          }
        }

        return undefined;
      }

      /*
       * Listing the nested directory failed even though the parent listing
       * says it exists (permissions, provider hiccup). Fall through to probes.
       */
    } else if (exact == null) {
      /*
       * The parent listing is authoritative: neither the exact name nor any
       * extension exists, and a missing path cannot have an index module.
       */
      return undefined;
    }
  }

  if ((await reader.readBytes(normalized)) != null) {
    return normalized;
  }

  if (!canAppendExtension) {
    return undefined;
  }

  for (const extension of extensions) {
    const candidate = `${normalized}${extension}`;

    if ((await reader.readBytes(candidate)) != null) {
      return candidate;
    }
  }

  for (const trail of indexTrails) {
    const candidate = `${normalized}${trail}`;

    if ((await reader.readBytes(candidate)) != null) {
      return candidate;
    }
  }

  return undefined;
}

function joinFromImporter(importer: string, specifier: string): string {
  if (specifier.startsWith("/")) {
    return normalizePath(specifier);
  }

  const importerDirectory = getImporterDirectory(importer);

  return normalizePath(
    importerDirectory.length > 0 ? `${importerDirectory}/${specifier}` : specifier,
  );
}

function getPackageJsonPath(packageDirectory: string): string {
  return `${packageDirectory}/package.json`;
}

/*
 * Resolves a conditional target object using package key order, matching
 * Node-style conditional exports behavior. Package authors control condition
 * priority by object key order, not by the order of our condition set.
 */
function resolveConditionalTarget(
  target: unknown,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (typeof target === "string") {
    return target;
  }

  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalTarget(candidate, conditions);

      if (resolved != null) {
        return resolved;
      }
    }

    return undefined;
  }

  if (typeof target !== "object" || target == null) {
    return undefined;
  }

  for (const key of Object.keys(target as Record<string, unknown>)) {
    if (!conditions.has(key)) {
      continue;
    }

    const resolved = resolveConditionalTarget((target as Record<string, unknown>)[key], conditions);

    if (resolved != null) {
      return resolved;
    }
  }

  return undefined;
}

function packageTargetPath(packageDirectory: string, target: string): string | undefined {
  if (!target.startsWith("./")) {
    return undefined;
  }

  return normalizePath(`${packageDirectory}/${target}`);
}

/*
 * Direct-read package resolver. It replaces the former file-map resolver and
 * reads only the package manifests and module files actually reached by the
 * current dependency graph.
 */
function createPackageResolver(
  getReader: () => WorkspaceReader,
  getGeneration: () => number,
  options: ResolverOptions,
): PackageResolver {
  const packageJsonCache = new Map<string, Promise<PackageJson | undefined>>();
  const packageDirectoryCache = new Map<string, Promise<string | undefined>>();

  let cacheGeneration = getGeneration();

  function resetCachesForGeneration(): void {
    if (cacheGeneration !== getGeneration()) {
      packageJsonCache.clear();
      packageDirectoryCache.clear();
      cacheGeneration = getGeneration();
    }
  }

  async function readPackageJson(packageDirectory: string): Promise<PackageJson | undefined> {
    resetCachesForGeneration();

    const packageJsonPath = getPackageJsonPath(packageDirectory);
    const existing = packageJsonCache.get(packageJsonPath);

    if (existing != null) {
      return existing;
    }

    const pending = getReader()
      .readText(packageJsonPath)
      .then((text) => (text == null ? undefined : parseJsonSafe(text)));

    packageJsonCache.set(packageJsonPath, pending);

    return pending;
  }

  async function findContainingPackage(path: string): Promise<string | undefined> {
    resetCachesForGeneration();

    const normalized = normalizePath(path);
    const existing = packageDirectoryCache.get(normalized);

    if (existing != null) {
      return existing;
    }

    const pending = (async () => {
      const segments = normalized.split("/").filter((segment) => segment.length > 0);

      segments.pop();

      for (let index = segments.length; index >= 0; index -= 1) {
        const directory = segments.slice(0, index).join("/");
        const packageJson = await readPackageJson(directory);

        if (packageJson != null) {
          return directory;
        }
      }

      return undefined;
    })();

    packageDirectoryCache.set(normalized, pending);

    return pending;
  }

  function lookup(path: string): Promise<string | undefined> {
    return resolveWithListing(
      getReader(),
      path,
      options.resolveExtensions,
      indexTrailsFor(options.resolveExtensions),
    );
  }

  async function resolveExportTarget(
    packageDirectory: string,
    target: string,
  ): Promise<string | undefined> {
    const path = packageTargetPath(packageDirectory, target);

    return path == null ? undefined : lookup(path);
  }

  async function resolveExportsField(
    exportsField: unknown,
    subpath: string,
    packageDirectory: string,
    conditions: ReadonlySet<string>,
  ): Promise<string | undefined> {
    if (exportsField == null) {
      return undefined;
    }

    if (typeof exportsField === "string") {
      if (subpath.length > 0) {
        return undefined;
      }

      return resolveExportTarget(packageDirectory, exportsField);
    }

    if (Array.isArray(exportsField)) {
      for (const candidate of exportsField) {
        const resolved = await resolveExportsField(
          candidate,
          subpath,
          packageDirectory,
          conditions,
        );

        if (resolved != null) {
          return resolved;
        }
      }

      return undefined;
    }

    if (typeof exportsField !== "object") {
      return undefined;
    }

    const map = exportsField as Record<string, unknown>;
    const requestedSubpath = subpath.length === 0 ? "." : `./${subpath.replace(/^\.\//, "")}`;
    const hasSubpathEntries = Object.keys(map).some((key) => key === "." || key.startsWith("./"));

    if (hasSubpathEntries) {
      const directTarget = map[requestedSubpath];

      if (directTarget != null) {
        return resolveExportsField(directTarget, "", packageDirectory, conditions);
      }

      for (const [pattern, target] of Object.entries(map)) {
        if (!pattern.includes("*")) {
          continue;
        }

        const starIndex = pattern.indexOf("*");
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);

        if (
          !requestedSubpath.startsWith(prefix) ||
          !requestedSubpath.endsWith(suffix) ||
          requestedSubpath.length < prefix.length + suffix.length
        ) {
          continue;
        }

        const wildcard = requestedSubpath.slice(
          prefix.length,
          requestedSubpath.length - suffix.length,
        );
        const conditionalTarget = resolveConditionalTarget(target, conditions);

        if (conditionalTarget != null) {
          return resolveExportTarget(packageDirectory, conditionalTarget.replaceAll("*", wildcard));
        }
      }

      return undefined;
    }

    const conditionalTarget = resolveConditionalTarget(map, conditions);

    return conditionalTarget == null
      ? undefined
      : resolveExportTarget(packageDirectory, conditionalTarget);
  }

  async function findPackageDirectory(packageName: string): Promise<string | undefined> {
    const candidates = [
      `node_modules/${packageName}`,
      ...options.nodePaths.map((nodePath) =>
        nodePath.length > 0 ? `${nodePath}/${packageName}` : packageName,
      ),
    ];

    for (const candidate of candidates) {
      if ((await readPackageJson(candidate)) != null) {
        return candidate;
      }
    }

    return undefined;
  }

  async function browserMapFor(
    packageDirectory: string,
  ): Promise<Record<string, string | false> | undefined> {
    const packageJson = await readPackageJson(packageDirectory);
    const browser = packageJson?.browser;

    if (browser == null || typeof browser !== "object" || Array.isArray(browser)) {
      return undefined;
    }

    const mappings: Record<string, string | false> = {};

    for (const [key, value] of Object.entries(browser as Record<string, unknown>)) {
      if (typeof value === "string" || value === false) {
        mappings[key.replaceAll("\\", "/")] = value;
      }
    }

    return Object.keys(mappings).length > 0 ? mappings : undefined;
  }

  async function resolveBrowserTarget(
    packageDirectory: string,
    target: string,
    kind: string,
    depth: number,
  ): Promise<string | undefined> {
    if (target.startsWith(".")) {
      return lookup(normalizePath(`${packageDirectory}/${target}`));
    }

    return resolveBareImport(target, kind, depth + 1);
  }

  async function applyBrowserFileMapping(
    path: string,
    kind: string,
    depth: number,
  ): Promise<string | undefined | false> {
    if (options.platform !== "browser") {
      return undefined;
    }

    const packageDirectory = await findContainingPackage(path);

    if (packageDirectory == null) {
      return undefined;
    }

    const mappings = await browserMapFor(packageDirectory);

    if (mappings == null) {
      return undefined;
    }

    const relative = `./${path.slice(packageDirectory.length + 1)}`;
    const extensionless = relative.replace(/\.[^./]+$/, "");

    for (const [key, target] of Object.entries(mappings)) {
      if (key.startsWith(".") || key.startsWith("/")) {
        const normalizedKey = key.startsWith("/") ? `.${key}` : key;

        if (normalizedKey !== relative && normalizedKey !== extensionless) {
          continue;
        }

        if (target === false) {
          return false;
        }

        const resolved = await resolveBrowserTarget(packageDirectory, target, kind, depth);

        return resolved ?? undefined;
      }
    }

    return undefined;
  }

  async function applyBrowserSpecifierMapping(
    specifier: string,
    importer: string,
    kind: string,
    depth: number,
  ): Promise<string | undefined | false> {
    if (options.platform !== "browser") {
      return undefined;
    }

    const packageDirectory = await findContainingPackage(importer);

    if (packageDirectory == null) {
      return undefined;
    }

    const mappings = await browserMapFor(packageDirectory);

    if (mappings == null) {
      return undefined;
    }

    const direct = mappings[specifier];

    if (direct == null) {
      return undefined;
    }

    if (direct === false) {
      return false;
    }

    return (await resolveBrowserTarget(packageDirectory, direct, kind, depth)) ?? undefined;
  }

  async function resolveBareImport(
    specifier: string,
    kind: string,
    depth = 0,
  ): Promise<string | undefined> {
    if (depth > 8) {
      return undefined;
    }

    const { packageDir: defaultPackageDir, subpath } = splitPackageSpec(specifier);
    const packageName = defaultPackageDir.slice("node_modules/".length);
    const packageDirectory = await findPackageDirectory(packageName);
    const packageJson =
      packageDirectory == null ? undefined : await readPackageJson(packageDirectory);
    const conditions = conditionsForKind(options, kind);

    if (packageDirectory != null && packageJson != null) {
      if (packageJson.exports != null) {
        const resolved = await resolveExportsField(
          packageJson.exports,
          subpath,
          packageDirectory,
          conditions,
        );

        if (resolved == null) {
          return undefined;
        }

        const mapped = await applyBrowserFileMapping(resolved, kind, depth);

        return mapped === false ? EMPTY_MODULE_PATH : (mapped ?? resolved);
      }

      const browserMappings =
        options.platform === "browser" ? await browserMapFor(packageDirectory) : undefined;
      const mappedTarget =
        browserMappings?.[subpath.length === 0 ? "." : `./${subpath}`] ??
        (subpath.length === 0 ? browserMappings?.["./"] : undefined);

      if (mappedTarget != null) {
        if (mappedTarget === false) {
          return EMPTY_MODULE_PATH;
        }

        return resolveBrowserTarget(packageDirectory, mappedTarget, kind, depth);
      }

      if (subpath.length > 0) {
        const resolved = await lookup(`${packageDirectory}/${subpath}`);

        if (resolved == null) {
          return undefined;
        }

        const mapped = await applyBrowserFileMapping(resolved, kind, depth);

        return mapped === false ? EMPTY_MODULE_PATH : (mapped ?? resolved);
      }

      for (const field of mainFieldsFor(options, kind, packageJson)) {
        const target = packageJson[field];

        if (typeof target !== "string" || target.length === 0) {
          continue;
        }

        const resolved = await resolveExportTarget(packageDirectory, target);

        if (resolved != null) {
          const mapped = await applyBrowserFileMapping(resolved, kind, depth);

          return mapped === false ? EMPTY_MODULE_PATH : (mapped ?? resolved);
        }
      }
    }

    if (subpath.length > 0) {
      return lookup(`${packageDirectory ?? defaultPackageDir}/${subpath}`);
    }

    return lookup(packageDirectory ?? defaultPackageDir);
  }

  async function resolvePackageImport(
    specifier: string,
    importer: string,
    kind: string,
    depth = 0,
  ): Promise<string | undefined> {
    if (depth > 8) {
      return undefined;
    }

    const packageDirectory = await findContainingPackage(importer);

    if (packageDirectory == null) {
      return undefined;
    }

    const packageJson = await readPackageJson(packageDirectory);

    if (
      packageJson?.imports == null ||
      typeof packageJson.imports !== "object" ||
      Array.isArray(packageJson.imports)
    ) {
      return undefined;
    }

    const imports = packageJson.imports as Record<string, unknown>;
    let target = imports[specifier];
    let wildcard: string | undefined;

    if (target == null) {
      for (const [pattern, candidate] of Object.entries(imports)) {
        if (!pattern.includes("*")) {
          continue;
        }

        const starIndex = pattern.indexOf("*");
        const prefix = pattern.slice(0, starIndex);
        const suffix = pattern.slice(starIndex + 1);

        if (
          !specifier.startsWith(prefix) ||
          !specifier.endsWith(suffix) ||
          specifier.length < prefix.length + suffix.length
        ) {
          continue;
        }

        wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
        target = candidate;
        break;
      }
    }

    if (target == null) {
      return undefined;
    }

    const conditionalTarget = resolveConditionalTarget(target, conditionsForKind(options, kind));

    if (conditionalTarget == null) {
      return undefined;
    }

    const substituted =
      wildcard == null ? conditionalTarget : conditionalTarget.replaceAll("*", wildcard);

    if (substituted.startsWith("#")) {
      return resolvePackageImport(substituted, importer, kind, depth + 1);
    }

    if (substituted.startsWith(".")) {
      return resolveExportTarget(packageDirectory, substituted);
    }

    return resolveBareImport(substituted, kind, depth + 1);
  }

  async function sideEffectsFor(path: string): Promise<boolean | undefined> {
    const packageDirectory = await findContainingPackage(path);

    if (packageDirectory == null) {
      return undefined;
    }

    const packageJson = await readPackageJson(packageDirectory);
    const sideEffects = packageJson?.sideEffects;

    if (sideEffects === false) {
      return false;
    }

    if (Array.isArray(sideEffects)) {
      const relative = path.slice(packageDirectory.length + 1);
      const patterns = sideEffects.filter((item): item is string => typeof item === "string");
      const matches = patterns.some((pattern) =>
        picomatch(pattern.replace(/^\.\//, ""), { dot: true })(relative),
      );

      return matches ? undefined : false;
    }

    return undefined;
  }

  return {
    resolveBareImport,
    resolvePackageImport,
    applyBrowserSpecifierMapping,
    applyBrowserFileMapping,
    sideEffectsFor,
  };
}

async function resolveRelativeWorkspacePath(
  reader: WorkspaceReader,
  path: string,
  extensions: readonly string[] = DEFAULT_RESOLVE_EXTENSIONS,
): Promise<string | undefined> {
  return resolveWithListing(reader, path, extensions, indexTrailsFor(extensions));
}

/**
 * Resolve one workspace-relative entry point using esbuild's extension and
 * index rules. Exported so the extension can report missing entries before
 * starting a build.
 */
export async function resolveWorkspaceEntry(
  reader: WorkspaceReader,
  entry: string,
  resolveExtensions?: readonly string[],
): Promise<string | undefined> {
  const extensions = normalizeExtensionList(resolveExtensions);

  return resolveRelativeWorkspacePath(reader, normalizePath(entry), extensions);
}

type ParsedTsconfig = {
  raw: string;
  options: Record<string, unknown>;
  directory: string;
  baseUrlDirectory: string;
};

async function readTsconfigFile(
  reader: WorkspaceReader,
  path: string,
  seen: Set<string>,
  depth = 0,
): Promise<ParsedTsconfig | undefined> {
  if (depth > 8 || seen.has(path)) {
    return undefined;
  }

  seen.add(path);

  const text = await reader.readText(path);

  if (text == null) {
    return undefined;
  }

  const json = parseJsoncSafe(text);

  if (json == null) {
    return undefined;
  }

  const directory = directoryOf(path);
  const compilerOptions =
    typeof json.compilerOptions === "object" &&
    json.compilerOptions != null &&
    !Array.isArray(json.compilerOptions)
      ? (json.compilerOptions as Record<string, unknown>)
      : {};

  let inherited: ParsedTsconfig | undefined;

  if (typeof json.extends === "string" && json.extends.startsWith(".")) {
    const extendsPath = normalizePath(
      json.extends.endsWith(".json")
        ? `${directory}/${json.extends}`
        : `${directory}/${json.extends}.json`,
    );

    inherited = await readTsconfigFile(reader, extendsPath, seen, depth + 1);
  }

  const options = { ...(inherited?.options ?? {}), ...compilerOptions };
  const baseUrlDirectory =
    typeof compilerOptions.baseUrl === "string"
      ? joinWorkspacePath(directory, compilerOptions.baseUrl)
      : (inherited?.baseUrlDirectory ?? directory);

  return {
    raw: text,
    options,
    directory,
    baseUrlDirectory,
  };
}

async function loadTsconfig(
  reader: WorkspaceReader,
  request: BuildRequest,
): Promise<TsconfigResolution> {
  const rawTsconfig =
    request.tsconfigRaw == null
      ? undefined
      : typeof request.tsconfigRaw === "string"
        ? request.tsconfigRaw
        : JSON.stringify(request.tsconfigRaw);

  if (rawTsconfig != null && rawTsconfig.trim().length > 0) {
    const json = parseJsoncSafe(rawTsconfig) ?? {};
    const options =
      typeof json.compilerOptions === "object" &&
      json.compilerOptions != null &&
      !Array.isArray(json.compilerOptions)
        ? (json.compilerOptions as Record<string, unknown>)
        : {};

    return {
      raw: rawTsconfig,
      directory: "",
      ...(typeof options.baseUrl === "string"
        ? { baseUrl: joinWorkspacePath("", options.baseUrl) }
        : {}),
      ...(typeof options.paths === "object" && options.paths != null
        ? { paths: normalizeTsconfigPaths(options.paths) }
        : {}),
    };
  }

  const candidates =
    request.tsconfig != null ? [request.tsconfig] : ["tsconfig.json", "jsconfig.json"];

  for (const candidate of candidates) {
    const parsed = await readTsconfigFile(reader, normalizePath(candidate), new Set());

    if (parsed == null) {
      continue;
    }

    const baseUrl =
      typeof parsed.options.baseUrl === "string" ? parsed.baseUrlDirectory : undefined;

    return {
      /*
       * Pass the merged compilerOptions rather than the original file: esbuild
       * runs inside the wasm virtual filesystem and cannot follow "extends"
       * from a workspace tsconfig on its own.
       */
      raw: JSON.stringify({ compilerOptions: parsed.options }),
      path: normalizePath(candidate),
      directory: parsed.directory,
      ...(baseUrl != null ? { baseUrl } : {}),
      ...(typeof parsed.options.paths === "object" && parsed.options.paths != null
        ? { paths: normalizeTsconfigPaths(parsed.options.paths) }
        : {}),
    };
  }

  return { directory: "" };
}

function normalizeTsconfigPaths(value: object): Record<string, string[]> | undefined {
  const paths: Record<string, string[]> = {};

  for (const [key, targets] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(targets)) {
      continue;
    }

    const normalized = targets.filter(
      (target): target is string => typeof target === "string" && target.length > 0,
    );

    if (normalized.length > 0) {
      paths[key] = normalized;
    }
  }

  return Object.keys(paths).length > 0 ? paths : undefined;
}

function createWorkspaceFsPlugin(
  getReader: () => WorkspaceReader,
  getGeneration: () => number,
  options: ResolverOptions,
  dependencyPaths: Set<string>,
  loaderOverrides?: Record<string, string>,
): esbuild.Plugin {
  return {
    name: "dataverse-ide-workspace-fs",

    setup(build) {
      const packageResolver = createPackageResolver(getReader, getGeneration, options);

      const workspaceResult = async (
        path: string,
        sideEffects?: boolean,
      ): Promise<esbuild.OnResolveResult> => {
        const normalized = normalizePath(path);

        dependencyPaths.add(normalized);

        const inferredSideEffects =
          sideEffects === false ? false : await packageResolver.sideEffectsFor(normalized);

        return {
          path: normalized,
          namespace: "workspace",
          ...(inferredSideEffects === false ? { sideEffects: false } : {}),
        };
      };

      const resolveSpecifier = async (
        specifier: string,
        importer: string,
        kind: string,
        depth = 0,
      ): Promise<esbuild.OnResolveResult | undefined> => {
        if (depth > 8) {
          return undefined;
        }

        if (matchesExternal(specifier, options.external)) {
          return { path: specifier, external: true };
        }

        const aliased = applyAlias(specifier, options.alias);

        if (aliased !== specifier) {
          return resolveSpecifier(aliased, importer, kind, depth + 1);
        }

        if (specifier.startsWith("#")) {
          const resolved = await packageResolver.resolvePackageImport(
            specifier.normalize("NFC"),
            importer.normalize("NFC"),
            kind,
          );

          return resolved == null ? undefined : workspaceResult(resolved);
        }

        const browserSpecifier = await packageResolver.applyBrowserSpecifierMapping(
          specifier,
          importer,
          kind,
          depth,
        );

        if (browserSpecifier === false) {
          return workspaceResult(EMPTY_MODULE_PATH);
        }

        if (typeof browserSpecifier === "string") {
          return resolveSpecifier(browserSpecifier, importer, kind, depth + 1);
        }

        if (isBareSpecifier(specifier)) {
          if (
            options.platform === "node" &&
            (NODE_BUILTINS.has(specifier) || specifier.startsWith("node:"))
          ) {
            return { path: specifier, external: true };
          }

          if (options.packages === "external") {
            return { path: specifier, external: true };
          }

          const tsconfigResolved = await resolveTsconfigPath(
            getReader(),
            specifier,
            options.tsconfig,
            options.resolveExtensions,
          );

          if (tsconfigResolved != null) {
            return workspaceResult(tsconfigResolved);
          }

          const resolved = await packageResolver.resolveBareImport(normalizePath(specifier), kind);

          if (resolved == null) {
            return undefined;
          }

          if (resolved === EMPTY_MODULE_PATH) {
            return workspaceResult(EMPTY_MODULE_PATH);
          }

          const browserMapped = await packageResolver.applyBrowserFileMapping(
            resolved,
            kind,
            depth,
          );

          if (browserMapped === false) {
            return workspaceResult(EMPTY_MODULE_PATH);
          }

          return workspaceResult(browserMapped ?? resolved);
        }

        const joined = joinFromImporter(importer, specifier);
        const resolved = await resolveRelativeWorkspacePath(
          getReader(),
          joined,
          options.resolveExtensions,
        );

        if (resolved == null) {
          return undefined;
        }

        const browserMapped = await packageResolver.applyBrowserFileMapping(resolved, kind, depth);

        if (browserMapped === false) {
          return workspaceResult(EMPTY_MODULE_PATH);
        }

        return workspaceResult(browserMapped ?? resolved);
      };

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") {
          const resolved = await resolveRelativeWorkspacePath(
            getReader(),
            normalizePath(args.path),
            options.resolveExtensions,
          );

          if (resolved == null) {
            return {
              errors: [
                {
                  text: `Could not resolve entry point "${args.path}".`,
                },
              ],
            };
          }

          return workspaceResult(resolved);
        }

        return resolveSpecifier(args.path, args.importer, args.kind);
      });

      build.onLoad(
        {
          filter: /.*/,
          namespace: "workspace",
        },
        async (args) => {
          const normalizedPath = normalizePath(args.path);

          if (normalizedPath === EMPTY_MODULE_PATH) {
            return {
              contents: "export default {};",
              loader: "js",
            };
          }

          const loader = getLoaderForPath(normalizedPath, loaderOverrides);
          const binary = loader != null && BINARY_LOADERS.has(loader);
          const contents = binary
            ? await getReader().readBytes(normalizedPath)
            : await getReader().readText(normalizedPath);

          if (contents == null) {
            return {
              errors: [
                {
                  text: `File not found in workspace: "${normalizedPath}".`,
                },
              ],
            };
          }

          return {
            contents,
            ...(loader != null ? { loader } : {}),
          };
        },
      );
    },
  };
}

async function resolveTsconfigPath(
  reader: WorkspaceReader,
  specifier: string,
  tsconfig: TsconfigResolution,
  resolveExtensions: readonly string[],
): Promise<string | undefined> {
  const baseDirectory = tsconfig.baseUrl ?? tsconfig.directory;

  if (tsconfig.paths != null) {
    for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
      const starIndex = pattern.indexOf("*");

      if (starIndex === -1) {
        if (pattern !== specifier) {
          continue;
        }

        for (const target of targets) {
          const resolved = await resolveWithListing(
            reader,
            joinWorkspacePath(baseDirectory, target),
            resolveExtensions,
            indexTrailsFor(resolveExtensions),
          );

          if (resolved != null) {
            return resolved;
          }
        }

        continue;
      }

      const prefix = pattern.slice(0, starIndex);
      const suffix = pattern.slice(starIndex + 1);

      if (
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix) ||
        specifier.length < prefix.length + suffix.length
      ) {
        continue;
      }

      const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);

      for (const target of targets) {
        const resolved = await resolveWithListing(
          reader,
          joinWorkspacePath(baseDirectory, target.replaceAll("*", wildcard)),
          resolveExtensions,
          indexTrailsFor(resolveExtensions),
        );

        if (resolved != null) {
          return resolved;
        }
      }
    }
  }

  if (tsconfig.baseUrl != null) {
    return resolveWithListing(
      reader,
      joinWorkspacePath(tsconfig.baseUrl, specifier),
      resolveExtensions,
      indexTrailsFor(resolveExtensions),
    );
  }

  return undefined;
}

export async function runTransform(request: TransformRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized();

    const extension = request.filename.split(".").at(-1)?.toLowerCase() ?? "js";

    const loaderByExtension: Record<string, esbuild.Loader> = {
      ts: "ts",
      mts: "ts",
      cts: "ts",
      tsx: "tsx",
      jsx: "jsx",
      css: "css",
      json: "json",
    };

    const result = await esbuild.transform(request.source, {
      loader: loaderByExtension[extension] ?? "js",
      format: "cjs",
      target: "es2022",
      sourcemap: false,
      minify: request.minify ?? false,
      logLevel: "silent",
    });

    return {
      id: request.id,
      ok: true,
      outputs: [
        {
          path: request.filename,
          contents: new TextEncoder().encode(result.code),
          text: result.code,
        },
      ],
      warnings: result.warnings.map((warning) => warning.text),
      dependencies: [],
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type BundlerTransformOptions = {
  filename: string;
  source: string;
  define?: Record<string, string>;
  minify?: boolean;
  sourcemap?: boolean;
  format?: "esm" | "iife" | "cjs";
  supported?: Record<string, boolean>;
};

/*
 * Shared esbuild-wasm transform for non-esbuild bundlers.
 *
 * Rollup uses this for TS/JSX lowering, define substitution and minification
 * on the main thread. Reusing compiler.ts means esbuild-wasm is initialized
 * exactly once per page (the esbuild extension normally initializes it
 * first), and the Dataverse wasm-binary virtual module stays in one place.
 */
export async function transformForBundler(
  options: BundlerTransformOptions,
): Promise<{ code: string; map: unknown }> {
  await ensureInitialized();

  const result = await esbuild.transform(options.source, {
    loader: getLoaderForPath(options.filename) ?? "js",
    ...(options.format != null ? { format: options.format } : {}),
    target: "es2022",
    define: options.define,
    minify: options.minify ?? false,
    sourcemap: options.sourcemap === true,
    supported: options.supported,
    /*
     * Rollup does not run esbuild's JSX loader itself; automatic matches the
     * modern jsx-runtime convention used by the rest of the toolchain.
     */
    jsx: "automatic",
    logLevel: "silent",
  });

  return {
    code: result.code,
    map:
      result.map != null && result.map.length > 0 ? (JSON.parse(result.map) as unknown) : undefined,
  };
}

type BuildState = {
  request: BuildRequest;
  reader: WorkspaceReader;
  dependencyPaths: Set<string>;
  generation: number;
};

function createResolverOptions(
  request: BuildRequest,
  tsconfig: TsconfigResolution,
): ResolverOptions {
  return {
    platform: request.platform ?? "browser",
    external: request.external ?? [],
    alias: request.alias ?? {},
    packages: request.packages ?? "bundle",
    conditions: request.conditions,
    mainFields: request.mainFields,
    resolveExtensions: normalizeExtensionList(request.resolveExtensions),
    nodePaths: request.nodePaths ?? [],
    tsconfig,
  };
}

function createBuildPlugins(state: BuildState, resolverOptions: ResolverOptions): esbuild.Plugin[] {
  const { request } = state;
  const solid = request.solid ?? "off";
  const plugins: esbuild.Plugin[] = [];

  /*
   * Solid compiles before esbuild's loaders and before the workspace-fs
   * plugin's catch-all onLoad (esbuild tries onLoad callbacks in plugin
   * order). It only claims workspace .jsx/.tsx files; everything else
   * falls through to the normal loader.
   */
  if (solid !== "off") {
    plugins.push(
      createSolidEsbuildPlugin({
        version: solid,
        readText: (path) => state.reader.readText(path),
        sourcemap: request.sourcemap != null && request.sourcemap !== false,
      }),
    );
  }

  plugins.push(
    createWorkspaceFsPlugin(
      () => state.reader,
      () => state.generation,
      resolverOptions,
      state.dependencyPaths,
      request.loader,
    ),
  );

  return plugins;
}

function normalizeEntryPoint(entry: EntryPoint): string | { in: string; out: string } {
  if (typeof entry === "string") {
    return normalizePath(entry);
  }

  const input = normalizePath(entry.in);
  const output = entry.out == null ? "" : normalizePath(entry.out);

  return output.length === 0 ? input : { in: input, out: output };
}

function outputTextOption(
  value: string | { js?: string; css?: string } | undefined,
): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    return { js: value };
  }

  return value as Record<string, string>;
}

function compileRegExp(pattern: string | undefined, name: string): RegExp | undefined {
  if (pattern == null || pattern.length === 0) {
    return undefined;
  }

  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `${name} is not a valid regular expression: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function createBuildOptions(
  request: BuildRequest,
  plugins: esbuild.Plugin[],
  tsconfig: TsconfigResolution,
): Promise<esbuild.BuildOptions> {
  const entryPoints = request.entries.map(normalizeEntryPoint);

  if (entryPoints.length === 0) {
    throw new Error("At least one entry point is required.");
  }

  const outdir = request.outfile == null ? (request.outdir ?? "out") : undefined;

  return {
    entryPoints,
    bundle: request.bundle ?? true,
    write: false,
    format: request.format,
    platform: request.platform ?? "browser",
    charset: request.charset,
    globalName: request.globalName,
    minify: request.minify ?? false,
    ...(request.minifyWhitespace === true ? { minifyWhitespace: true } : {}),
    ...(request.minifyIdentifiers === true ? { minifyIdentifiers: true } : {}),
    ...(request.minifySyntax === true ? { minifySyntax: true } : {}),
    sourcemap: request.sourcemap ?? false,
    sourceRoot: request.sourceRoot,
    sourcesContent: request.sourcesContent,
    target: request.target,
    treeShaking: request.treeShaking,
    ignoreAnnotations: request.ignoreAnnotations,
    keepNames: request.keepNames,
    legalComments: request.legalComments,
    lineLimit: request.lineLimit != null && request.lineLimit > 0 ? request.lineLimit : undefined,
    drop: request.drop,
    dropLabels: request.dropLabels,
    banner: outputTextOption(request.banner),
    footer: outputTextOption(request.footer),
    pure: request.pure,
    mangleProps: compileRegExp(request.mangleProps, "mangleProps"),
    reserveProps: compileRegExp(request.reserveProps, "reserveProps"),
    jsx: request.jsx,
    jsxFactory: request.jsxFactory,
    jsxFragment: request.jsxFragment,
    jsxImportSource: request.jsxImportSource,
    jsxDev: request.jsxDev,
    jsxSideEffects: request.jsxSideEffects,
    supported: request.supported,
    external: request.external,
    define: request.define,
    inject: request.inject,
    tsconfigRaw: tsconfig.raw,
    conditions: request.conditions,
    mainFields: request.mainFields,
    resolveExtensions: normalizeExtensionList(request.resolveExtensions),
    nodePaths: request.nodePaths,
    packages: request.packages,
    splitting: request.splitting,
    entryNames: request.entryNames,
    chunkNames: request.chunkNames,
    assetNames: request.assetNames,
    publicPath: request.publicPath,
    outExtension: request.outExtension,
    outbase: request.outbase,
    outfile: request.outfile,
    logLevel: "silent",
    /*
     * Needed for the dependency set handed back to watch mode. The metafile
     * is only used to decide which files can trigger a rebuild.
     */
    metafile: true,
    plugins,
    /*
     * outbase is left to esbuild unless configured. It derives the lowest
     * common ancestor of every entry point, which keeps "src/app.ts" writing
     * "app.js" while a multi-directory set ("src/a.ts", "lib/b.ts") writes
     * "src/a.js" and "lib/b.js" without colliding.
     */
    ...(outdir != null ? { outdir } : {}),
  };
}

/**
 * Stable identity for a reusable esbuild context. Everything that changes the
 * build options or the plugin setup must be part of this key; the workspace
 * reader and virtual-file *contents* are intentionally excluded because the
 * plugins read those through mutable build state on every rebuild.
 */
function buildRequestKey(request: BuildRequest): string {
  return JSON.stringify({
    entries: request.entries.map(normalizeEntryPoint),
    format: request.format,
    platform: request.platform ?? "browser",
    charset: request.charset,
    globalName: request.globalName,
    minify: request.minify ?? false,
    ...(request.minifyWhitespace === true ? { minifyWhitespace: true } : {}),
    ...(request.minifyIdentifiers === true ? { minifyIdentifiers: true } : {}),
    ...(request.minifySyntax === true ? { minifySyntax: true } : {}),
    sourcemap: request.sourcemap ?? false,
    sourceRoot: request.sourceRoot,
    sourcesContent: request.sourcesContent,
    target: request.target,
    treeShaking: request.treeShaking,
    ignoreAnnotations: request.ignoreAnnotations,
    keepNames: request.keepNames,
    legalComments: request.legalComments,
    lineLimit: request.lineLimit,
    drop: request.drop,
    dropLabels: request.dropLabels,
    banner: request.banner,
    footer: request.footer,
    pure: request.pure,
    mangleProps: request.mangleProps,
    reserveProps: request.reserveProps,
    jsx: request.jsx,
    jsxFactory: request.jsxFactory,
    jsxFragment: request.jsxFragment,
    jsxImportSource: request.jsxImportSource,
    jsxDev: request.jsxDev,
    jsxSideEffects: request.jsxSideEffects,
    supported: request.supported,
    bundle: request.bundle ?? true,
    splitting: request.splitting,
    external: request.external ?? [],
    alias: request.alias ?? {},
    define: request.define,
    loader: request.loader,
    inject: request.inject ?? [],
    tsconfig: request.tsconfig,
    tsconfigRaw: request.tsconfigRaw,
    conditions: request.conditions,
    mainFields: request.mainFields,
    resolveExtensions: request.resolveExtensions,
    nodePaths: request.nodePaths ?? [],
    packages: request.packages ?? "bundle",
    outdir: request.outdir,
    outfile: request.outfile,
    outbase: request.outbase,
    entryNames: request.entryNames,
    chunkNames: request.chunkNames,
    assetNames: request.assetNames,
    publicPath: request.publicPath,
    outExtension: request.outExtension,
    allowOverwrite: request.allowOverwrite,
    solid: request.solid ?? "off",
    virtualFiles: Object.keys(request.virtualFiles ?? {}).sort(),
  });
}

function collectDependencies(
  result: esbuild.BuildResult,
  resolvedPaths: ReadonlySet<string>,
): string[] {
  const metafile = (result as esbuild.BuildResult & { metafile?: esbuild.Metafile }).metafile;
  const dependencies = new Set<string>();

  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const path = input.startsWith("workspace:") ? input.slice("workspace:".length) : input;

    /*
     * Skip stdin and generated virtual modules (Tailwind's @plugin entry),
     * which are not real workspace files the watcher could observe.
     */
    if (path.startsWith("<") || path.startsWith("__")) {
      continue;
    }

    dependencies.add(normalizePath(path));
  }

  /*
   * Resolution can reach files that do not appear in the metafile (a build
   * that failed before linking, for example). Those are still dependencies
   * worth watching so the error can be fixed without another trigger.
   */
  for (const path of resolvedPaths) {
    if (!path.startsWith("<") && !path.startsWith("__")) {
      dependencies.add(normalizePath(path));
    }
  }

  return [...dependencies].sort();
}

function normalizeOutputPath(request: BuildRequest, outputPath: string): string {
  const normalized = normalizePath(outputPath);

  if (request.outfile != null) {
    const outfile = normalizePath(request.outfile);
    const markerIndex = normalized.lastIndexOf(outfile);

    if (markerIndex >= 0) {
      return `${outfile}${normalized.slice(markerIndex + outfile.length)}`;
    }

    const directory = directoryOf(outfile);

    return directory.length > 0
      ? `${directory}/${normalized.split("/").pop() ?? normalized}`
      : (normalized.split("/").pop() ?? normalized);
  }

  const outdir = normalizePath(request.outdir ?? "out");

  if (outdir.length === 0 || outdir === ".") {
    return normalized;
  }

  if (normalized === outdir) {
    return "";
  }

  if (normalized.startsWith(`${outdir}/`)) {
    return normalized;
  }

  const marker = `/${outdir}/`;
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return `${outdir}/${normalized.slice(markerIndex + marker.length)}`;
  }

  return normalized;
}

function toBuildResponse(
  request: BuildRequest,
  result: esbuild.BuildResult,
  dependencyPaths: ReadonlySet<string>,
): BuildSuccessResponse {
  return {
    id: request.id,
    ok: true,
    outputs: (result.outputFiles ?? [])
      .filter((file) => file.contents != null)
      .map((file) => ({
        path: normalizeOutputPath(request, file.path),
        contents: file.contents,
        text: file.text,
      }))
      .filter((file) => file.path.length > 0),
    warnings: result.warnings.map(
      (warning) =>
        `${warning.text}${
          warning.location != null ? ` (${formatLocation(warning.location)})` : ""
        }`,
    ),
    dependencies: collectDependencies(result, dependencyPaths),
  };
}

export async function runBuild(request: BuildRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized();

    const state: BuildState = {
      request,
      reader: withVirtualFiles(request.workspace, request.virtualFiles),
      dependencyPaths: new Set<string>(),
      generation: 0,
    };

    const tsconfig = await loadTsconfig(state.reader, request);

    if (tsconfig.path != null) {
      state.dependencyPaths.add(tsconfig.path);
    }

    const plugins = createBuildPlugins(state, createResolverOptions(request, tsconfig));
    const options = await createBuildOptions(request, plugins, tsconfig);
    const result = await esbuild.build(options);

    return toBuildResponse(request, result, state.dependencyPaths);
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reusable esbuild build context.
 *
 * esbuild-wasm supports `context()` + `rebuild()`, but not `watch()` (the
 * browser build has no filesystem watcher). The IDE's watcher drives rebuilds
 * and this session keeps esbuild's incremental graph alive between them.
 *
 * A fresh workspace reader is supplied for every rebuild, so source edits are
 * always visible even though the plugin closures themselves are stable. When
 * the build options change, the old context is disposed and a new one is
 * created.
 */
export class EsbuildBuildSession {
  private context: esbuild.BuildContext | undefined;

  private contextKey: string | undefined;

  private state: BuildState | undefined;

  async build(request: BuildRequest): Promise<BuildResponse> {
    try {
      await ensureInitialized();

      const reader = withVirtualFiles(request.workspace, request.virtualFiles);
      const tsconfig = await loadTsconfig(reader, request);
      /*
       * Include the tsconfig contents in the context key so editing the file
       * recreates the context instead of reusing stale compilerOptions.
       */
      const key = `${buildRequestKey(request)}\n${tsconfig.raw ?? ""}`;

      if (this.context == null || this.contextKey !== key) {
        await this.disposeContext();

        const state: BuildState = {
          request,
          reader,
          dependencyPaths: new Set<string>(),
          generation: 0,
        };

        if (tsconfig.path != null) {
          state.dependencyPaths.add(tsconfig.path);
        }

        const plugins = createBuildPlugins(state, createResolverOptions(request, tsconfig));

        this.context = await esbuild.context(await createBuildOptions(request, plugins, tsconfig));

        this.contextKey = key;
        this.state = state;
      } else {
        const state = this.state;

        if (state == null) {
          throw new Error("esbuild build session lost its state.");
        }

        state.request = request;
        state.reader = reader;
        state.dependencyPaths.clear();

        if (tsconfig.path != null) {
          state.dependencyPaths.add(tsconfig.path);
        }

        state.generation += 1;
      }

      const result = await this.context.rebuild();

      if (this.state == null) {
        throw new Error("esbuild build session lost its state.");
      }

      return toBuildResponse(request, result, this.state.dependencyPaths);
    } catch (error) {
      const dependencies =
        this.state == null
          ? []
          : [...this.state.dependencyPaths]
              .filter((path) => !path.startsWith("<") && !path.startsWith("__"))
              .map((path) => normalizePath(path))
              .sort();

      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(dependencies.length > 0 ? { dependencies } : {}),
      };
    }
  }

  async dispose(): Promise<void> {
    await this.disposeContext();
  }

  private async disposeContext(): Promise<void> {
    const context = this.context;

    this.context = undefined;
    this.contextKey = undefined;
    this.state = undefined;

    if (context != null) {
      try {
        await context.dispose();
      } catch {
        // A context that already failed to build may reject on dispose.
      }
    }
  }
}

function formatLocation(location: { file?: string; line?: number; column?: number }): string {
  return `${location.file ?? ""}:${location.line ?? 0}:${location.column ?? 0}`;
}
