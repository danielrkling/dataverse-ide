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

import type * as vscodeType from "vscode";

import {
  COMPANION_EXTENSIONS,
  EXPORT_CONDITIONS,
  INDEX_TRAILS,
  NODE_BUILTINS,
  RESOLVABLE_EXTENSIONS,
  hasFileExtension,
  normalizePath,
  parseJsonSafe,
  splitPackageSpec,
} from "../shared/packageResolver.js";

import { createSolidEsbuildPlugin, type SolidCompilerVersion } from "./solidPlugin.js";

export type BuildOutputFile = {
  path: string;
  text: string;
};

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
   * Workspace-relative or virtual entry point, e.g. src/app.ts or
   * __tailwind-plugin-entry__.mjs.
   */
  entry: string;

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
  banner?: { js?: string; css?: string };
  footer?: { js?: string; css?: string };
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
  define?: Record<string, string>;
  /** Extension -> esbuild loader overrides, e.g. { ".png": "dataurl" }. */
  loader?: Record<string, string>;
  entryNames?: string;
  chunkNames?: string;
  outExtension?: Record<string, string>;

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
  resolveBareImport: (specifier: string) => Promise<string | undefined>;
  resolvePackageImport: (specifier: string, importer: string) => Promise<string | undefined>;
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
  const fileCache = new Map<string, Promise<string | undefined>>();
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

    readText(path: string): Promise<string | undefined> {
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
          const bytes = await vscode.workspace.fs.readFile(uriFor(normalized));

          return new TextDecoder().decode(bytes);
        } catch {
          return undefined;
        }
      })();

      fileCache.set(normalized, pending);

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

function getLoaderForPath(path: string, loaderOverrides?: Record<string, string>): esbuild.Loader {
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

  if (path.endsWith(".css")) {
    return "css";
  }

  if (path.endsWith(".json")) {
    return "json";
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

  return "js";
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

  if (listing != null) {
    const exact = listing.get(name);

    if (exact === "file") {
      return normalized;
    }

    if (!hasFileExtension(normalized)) {
      for (const extension of extensions) {
        if (extension.length === 0) {
          continue;
        }

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

  if ((await reader.readText(normalized)) != null) {
    return normalized;
  }

  if (hasFileExtension(normalized)) {
    return undefined;
  }

  for (const extension of extensions) {
    const candidate = `${normalized}${extension}`;

    if ((await reader.readText(candidate)) != null) {
      return candidate;
    }
  }

  for (const trail of indexTrails) {
    const candidate = `${normalized}${trail}`;

    if ((await reader.readText(candidate)) != null) {
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
function resolveConditionalTarget(target: unknown): string | undefined {
  if (typeof target === "string") {
    return target;
  }

  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveConditionalTarget(candidate);

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
    if (!EXPORT_CONDITIONS.has(key)) {
      continue;
    }

    const resolved = resolveConditionalTarget((target as Record<string, unknown>)[key]);

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
  getGeneration: () => number = () => 0,
): PackageResolver {
  const packageJsonCache = new Map<string, Promise<PackageJson | undefined>>();

  let cacheGeneration = getGeneration();

  async function readPackageJson(packageDirectory: string): Promise<PackageJson | undefined> {
    const packageJsonPath = getPackageJsonPath(packageDirectory);

    /*
     * A reused esbuild context keeps this resolver alive across rebuilds.
     * Package manifests can change (npm install), so discard the cache for
     * each new build generation.
     */
    if (cacheGeneration !== getGeneration()) {
      packageJsonCache.clear();
      cacheGeneration = getGeneration();
    }

    const existing = packageJsonCache.get(packageJsonPath);

    if (existing != null) {
      return existing;
    }

    const pending = getReader()
      .readText(packageJsonPath)
      .then((text) => {
        if (text == null) {
          return undefined;
        }

        return parseJsonSafe(text);
      });

    packageJsonCache.set(packageJsonPath, pending);

    return pending;
  }

  async function lookup(path: string): Promise<string | undefined> {
    return resolveWithListing(getReader(), path, COMPANION_EXTENSIONS, INDEX_TRAILS);
  }

  async function resolveExportTarget(
    packageDirectory: string,
    target: string,
  ): Promise<string | undefined> {
    const path = packageTargetPath(packageDirectory, target);

    if (path == null) {
      return undefined;
    }

    return lookup(path);
  }

  async function resolveExportsField(
    exportsField: unknown,
    subpath: string,
    packageDirectory: string,
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
        const resolved = await resolveExportsField(candidate, subpath, packageDirectory);

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
        return resolveExportsField(directTarget, "", packageDirectory);
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

        if (typeof target === "string") {
          return resolveExportTarget(packageDirectory, target.replaceAll("*", wildcard));
        }

        const conditionalTarget = resolveConditionalTarget(target);

        if (conditionalTarget != null) {
          return resolveExportTarget(packageDirectory, conditionalTarget.replaceAll("*", wildcard));
        }
      }

      return undefined;
    }

    const conditionalTarget = resolveConditionalTarget(map);

    if (conditionalTarget == null) {
      return undefined;
    }

    return resolveExportTarget(packageDirectory, conditionalTarget);
  }

  async function findPackageRoot(importer: string): Promise<string | undefined> {
    const segments = normalizePath(importer)
      .split("/")
      .filter((segment) => segment.length > 0);

    segments.pop();

    for (let index = segments.length; index >= 0; index -= 1) {
      const directory = segments.slice(0, index).join("/");

      const packageJsonPath = directory.length > 0 ? `${directory}/package.json` : "package.json";

      if ((await getReader().readText(packageJsonPath)) != null) {
        return directory;
      }
    }

    return undefined;
  }

  async function resolvePackageImport(
    specifier: string,
    importer: string,
    depth = 0,
  ): Promise<string | undefined> {
    if (depth > 3) {
      return undefined;
    }

    const packageDirectory = await findPackageRoot(importer);

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

    const conditionalTarget = resolveConditionalTarget(target);

    if (conditionalTarget == null) {
      return undefined;
    }

    const substituted =
      wildcard == null ? conditionalTarget : conditionalTarget.replaceAll("*", wildcard);

    if (substituted.startsWith("#")) {
      return resolvePackageImport(substituted, importer, depth + 1);
    }

    if (!substituted.startsWith("./")) {
      return undefined;
    }

    return resolveExportTarget(packageDirectory, substituted);
  }

  async function resolveBareImport(specifier: string): Promise<string | undefined> {
    const { packageDir, subpath } = splitPackageSpec(specifier);

    const packageJson = await readPackageJson(packageDir);

    if (packageJson != null) {
      /*
       * exports is authoritative. Do not silently fall back to an internal
       * file when a package declares exports but rejects the requested
       * subpath.
       */
      if (packageJson.exports != null) {
        return resolveExportsField(packageJson.exports, subpath, packageDir);
      }

      if (subpath.length > 0) {
        return lookup(`${packageDir}/${subpath}`);
      }

      for (const field of ["browser", "module", "main"]) {
        const target = packageJson[field];

        if (typeof target !== "string" || target.length === 0) {
          continue;
        }

        const resolved = await resolveExportTarget(packageDir, target);

        if (resolved != null) {
          return resolved;
        }
      }
    }

    return subpath.length > 0 ? lookup(`${packageDir}/${subpath}`) : lookup(packageDir);
  }

  return {
    resolveBareImport,
    resolvePackageImport,
  };
}

async function resolveRelativeWorkspacePath(
  reader: WorkspaceReader,
  path: string,
): Promise<string | undefined> {
  return resolveWithListing(reader, path, RESOLVABLE_EXTENSIONS, INDEX_TRAILS);
}

function createWorkspaceFsPlugin(
  getReader: () => WorkspaceReader,
  getGeneration: () => number,
  externalPaths: string[],
  unresolvedImports: Set<string>,
  dependencyPaths: Set<string>,
  loaderOverrides?: Record<string, string>,
): esbuild.Plugin {
  return {
    name: "dataverse-ide-workspace-fs",

    setup(build) {
      const packageResolver = createPackageResolver(getReader, getGeneration);

      /*
       * Record every workspace path esbuild resolves, including files that
       * fail to load. A failed rebuild still updates the watch set, so fixing
       * the newly-added file triggers the next rebuild.
       */
      const workspaceResult = (path: string): esbuild.OnResolveResult => {
        const normalized = normalizePath(path);

        dependencyPaths.add(normalized);

        return {
          path: normalized,
          namespace: "workspace",
        };
      };

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") {
          return workspaceResult(args.path);
        }

        if (isConfiguredExternal(args.path, externalPaths)) {
          return {
            path: args.path,
            external: true,
          };
        }

        /*
         * Package import aliases resolve from the closest containing
         * package.json imports field.
         */
        if (args.path.startsWith("#")) {
          const resolved = await packageResolver.resolvePackageImport(
            args.path.normalize("NFC"),
            args.importer.normalize("NFC"),
          );

          if (resolved != null) {
            return workspaceResult(resolved);
          }

          /*
           * Leave unresolved # imports for esbuild to report. Unlike package
           * imports, silently externalizing them is not a safe fallback.
           */
          return undefined;
        }

        /*
         * Bare imports: Node builtins remain external; npm packages resolve
         * from workspace node_modules via the direct reader.
         */
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          if (NODE_BUILTINS.has(args.path) || args.path.startsWith("node:")) {
            return {
              path: args.path,
              external: true,
            };
          }

          const resolved = await packageResolver.resolveBareImport(normalizePath(args.path));

          if (resolved != null) {
            return workspaceResult(resolved);
          }

          unresolvedImports.add(`${args.path} imported by ${args.importer || "<entry point>"}`);

          return {
            path: args.path,
            external: true,
          };
        }

        /*
         * Relative and workspace-root-relative imports.
         */
        const joined = joinFromImporter(args.importer, args.path);

        const resolved = await resolveRelativeWorkspacePath(getReader(), joined);

        if (resolved != null) {
          return workspaceResult(resolved);
        }

        unresolvedImports.add(
          `Relative import "${args.path}" imported by "${args.importer || "<entry point>"}" ` +
            "was not found in the workspace and was left external in the output.",
        );

        return {
          path: joined,
          external: true,
        };
      });

      build.onLoad(
        {
          filter: /.*/,
          namespace: "workspace",
        },
        async (args) => {
          const normalizedPath = normalizePath(args.path);
          const contents = await getReader().readText(normalizedPath);

          if (contents == null) {
            return {
              errors: [
                {
                  text: `File not found in workspace: "${normalizedPath}".`,
                },
              ],
            };
          }

          const loader = getLoaderForPath(normalizedPath, loaderOverrides);

          return {
            contents,
            loader,
          };
        },
      );
    },
  };
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
    loader: getLoaderForPath(options.filename),
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
  unresolvedImports: Set<string>;
  dependencyPaths: Set<string>;
  generation: number;
};

function createBuildPlugins(state: BuildState): esbuild.Plugin[] {
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
      request.external ?? [],
      state.unresolvedImports,
      state.dependencyPaths,
      request.loader,
    ),
  );

  return plugins;
}

function createBuildOptions(
  request: BuildRequest,
  plugins: esbuild.Plugin[],
): esbuild.BuildOptions {
  const entryPoint = normalizePath(request.entry);
  const entryDirectory = entryPoint.includes("/")
    ? entryPoint.slice(0, entryPoint.lastIndexOf("/"))
    : ".";

  return {
    entryPoints: [entryPoint],
    bundle: request.bundle ?? true,
    write: false,
    format: request.format ?? "esm",
    platform: request.platform,
    charset: request.charset,
    globalName: request.globalName,
    minify: request.minify ?? false,
    sourcemap: request.sourcemap ?? false,
    sourceRoot: request.sourceRoot,
    sourcesContent: request.sourcesContent,
    target: request.target ?? "es2022",
    treeShaking: request.treeShaking,
    keepNames: request.keepNames,
    legalComments: request.legalComments,
    lineLimit: request.lineLimit != null && request.lineLimit > 0 ? request.lineLimit : undefined,
    drop: request.drop,
    banner: request.banner,
    footer: request.footer,
    pure: request.pure,
    jsx: request.jsx,
    jsxFactory: request.jsxFactory,
    jsxFragment: request.jsxFragment,
    jsxImportSource: request.jsxImportSource,
    jsxDev: request.jsxDev,
    jsxSideEffects: request.jsxSideEffects,
    external: request.external,
    define: request.define,
    splitting: request.splitting,
    entryNames: request.entryNames,
    chunkNames: request.chunkNames,
    outExtension: request.outExtension,
    logLevel: "silent",
    /*
     * Needed for the dependency set handed back to watch mode. The metafile
     * is only used to decide which files can trigger a rebuild.
     */
    metafile: true,
    plugins,
    /*
     * Keep the entry's own directory out of the output path, so
     * "src/app.ts" still writes "app.js" (plus sibling chunks/maps).
     */
    outbase: entryDirectory,
    outdir: "out",
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
    entry: normalizePath(request.entry),
    format: request.format ?? "esm",
    platform: request.platform,
    charset: request.charset,
    globalName: request.globalName,
    minify: request.minify ?? false,
    sourcemap: request.sourcemap ?? false,
    sourceRoot: request.sourceRoot,
    sourcesContent: request.sourcesContent,
    target: request.target ?? "es2022",
    treeShaking: request.treeShaking,
    keepNames: request.keepNames,
    legalComments: request.legalComments,
    lineLimit: request.lineLimit,
    drop: request.drop,
    banner: request.banner,
    footer: request.footer,
    pure: request.pure,
    jsx: request.jsx,
    jsxFactory: request.jsxFactory,
    jsxFragment: request.jsxFragment,
    jsxImportSource: request.jsxImportSource,
    jsxDev: request.jsxDev,
    jsxSideEffects: request.jsxSideEffects,
    bundle: request.bundle ?? true,
    splitting: request.splitting,
    external: request.external ?? [],
    define: request.define,
    loader: request.loader,
    entryNames: request.entryNames,
    chunkNames: request.chunkNames,
    outExtension: request.outExtension,
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

function toBuildResponse(
  request: BuildRequest,
  result: esbuild.BuildResult,
  unresolvedImports: ReadonlySet<string>,
  dependencyPaths: ReadonlySet<string>,
): BuildSuccessResponse {
  const warnings = [
    ...result.warnings.map(
      (warning) =>
        `${warning.text}${
          warning.location != null ? ` (${formatLocation(warning.location)})` : ""
        }`,
    ),

    ...[...unresolvedImports]
      .sort()
      .map(
        (detail) =>
          `Could not resolve npm package "${detail}". ` +
          "It was left external in the output bundle.",
      ),
  ];

  return {
    id: request.id,
    ok: true,
    outputs: (result.outputFiles ?? [])
      .filter((file) => file.contents != null)
      .map((file) => ({
        path: file.path,
        text: file.text,
      })),
    warnings,
    dependencies: collectDependencies(result, dependencyPaths),
  };
}

export async function runBuild(request: BuildRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized();

    const state: BuildState = {
      request,
      reader: withVirtualFiles(request.workspace, request.virtualFiles),
      unresolvedImports: new Set<string>(),
      dependencyPaths: new Set<string>(),
      generation: 0,
    };

    const result = await esbuild.build(createBuildOptions(request, createBuildPlugins(state)));

    return toBuildResponse(request, result, state.unresolvedImports, state.dependencyPaths);
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

      const key = buildRequestKey(request);

      if (this.context == null || this.contextKey !== key) {
        await this.disposeContext();

        const state: BuildState = {
          request,
          reader: withVirtualFiles(request.workspace, request.virtualFiles),
          unresolvedImports: new Set<string>(),
          dependencyPaths: new Set<string>(),
          generation: 0,
        };

        this.context = await esbuild.context(
          createBuildOptions(request, createBuildPlugins(state)),
        );

        this.contextKey = key;
        this.state = state;
      } else {
        const state = this.state;

        if (state == null) {
          throw new Error("esbuild build session lost its state.");
        }

        state.request = request;
        state.reader = withVirtualFiles(request.workspace, request.virtualFiles);
        state.unresolvedImports.clear();
        state.dependencyPaths.clear();
        state.generation += 1;
      }

      const result = await this.context.rebuild();

      if (this.state == null) {
        throw new Error("esbuild build session lost its state.");
      }

      return toBuildResponse(
        request,
        result,
        this.state.unresolvedImports,
        this.state.dependencyPaths,
      );
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
