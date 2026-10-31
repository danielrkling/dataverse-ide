/*
 * Main-thread esbuild compiler and workspace filesystem resolver.
 *
 * This replaces the earlier worker-only in-memory-file-map compiler path.
 * It reads source files directly through vscode.workspace.fs, which means:
 *
 * - no workspace-wide source collection
 * - no node_modules manifest scan
 * - no lazy probe/rebuild rounds
 * - no needFiles / absentPaths protocol
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
 * - tagged JSX transforms for workspace source files
 * - optional virtual source files for callers such as Tailwind @plugin
 */

import * as esbuild from "esbuild-wasm";
import wasmBase64 from "virtual:esbuild-wasm-binary";

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

import {
  createSolidEsbuildPlugin,
  isWorkspaceSourcePath,
  type SolidCompilerVersion,
} from "./solidPlugin.js";

export type TaggedJsxMode = "off" | "toJsx" | "toTagged";

export type BuildOutputFile = {
  path: string;
  text: string;
};

export type WorkspaceReader = {
  /**
   * Reads a workspace-relative UTF-8 text file. Returns undefined when the
   * file does not exist or cannot be read.
   */
  readText: (path: string) => Promise<string | undefined>;
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
  entryNames?: string;
  chunkNames?: string;
  outExtension?: Record<string, string>;
  taggedJsx?: TaggedJsxMode;

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
};

export type BuildFailureResponse = {
  id: number;
  ok: false;
  error: string;
};

export type BuildResponse = BuildSuccessResponse | BuildFailureResponse;

type PackageJson = Record<string, unknown>;

type PackageResolver = {
  resolveBareImport: (specifier: string) => Promise<string | undefined>;
  resolvePackageImport: (specifier: string, importer: string) => Promise<string | undefined>;
};

let initialization: Promise<void> | undefined;

/*
 * Tagged JSX plugin state is retained for the application lifetime.
 * TypeScript and @tagged-jsx/transform are loaded only when a build enables
 * taggedJsx.
 */
type TaggedJsxTransformers = {
  toJsx: (code: string) => {
    code: string;
    errors?: unknown[];
  };

  toTagged: (code: string) => {
    code: string;
    errors?: unknown[];
  };
};

let taggedJsxTransformersPromise: Promise<TaggedJsxTransformers> | undefined;

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
  const cache = new Map<string, Promise<string | undefined>>();

  return {
    readText(path: string): Promise<string | undefined> {
      const normalized = normalizePath(path);

      if (normalized.length === 0) {
        return Promise.resolve(undefined);
      }

      const existing = cache.get(normalized);

      if (existing != null) {
        return existing;
      }

      const pending = (async () => {
        try {
          const uri = vscode.Uri.joinPath(
            workspaceRootUri,
            ...normalized.split("/").filter((segment) => segment.length > 0),
          );

          const bytes = await vscode.workspace.fs.readFile(uri);

          return new TextDecoder().decode(bytes);
        } catch {
          return undefined;
        }
      })();

      cache.set(normalized, pending);

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

  for (const [path, contents] of Object.entries(virtualFiles)) {
    normalizedVirtualFiles.set(normalizePath(path), contents);
  }

  return {
    async readText(path: string): Promise<string | undefined> {
      const normalized = normalizePath(path);

      const virtual = normalizedVirtualFiles.get(normalized);

      if (virtual != null) {
        return virtual;
      }

      return workspace.readText(normalized);
    },
  };
}

async function ensureInitialized(): Promise<void> {
  if (initialization == null) {
    initialization = (async () => {
      const bytes = Uint8Array.from(atob(wasmBase64), (character) => character.charCodeAt(0));

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

function ensureTaggedJsxTransformers(): Promise<TaggedJsxTransformers> {
  taggedJsxTransformersPromise ??= Promise.all([
    import("@tagged-jsx/transform"),
    import("typescript"),
  ]).then(([transform, ts]) => {
    const callbacks = transform.createExpressionTransformCallbacks(ts);

    return {
      toJsx: transform.createJsxTransformer({
        tags: ["html", "jsx"],
        ts,
        callbacks,
      }),

      toTagged: transform.createTaggedTransformer({
        tag: "html",
        ts,
        callbacks,
        registeredComponents: [],
      }),
    };
  }) as Promise<TaggedJsxTransformers>;

  return taggedJsxTransformersPromise;
}

function getLoaderForPath(path: string): esbuild.Loader {
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

function isTaggedJsxCandidate(loader: esbuild.Loader): boolean {
  return loader === "ts" || loader === "tsx" || loader === "js" || loader === "jsx";
}

function transformTaggedJsxLoader(loader: esbuild.Loader, changed: boolean): esbuild.Loader {
  if (!changed) {
    return loader;
  }

  if (loader === "ts") {
    return "tsx";
  }

  if (loader === "js") {
    return "jsx";
  }

  return loader;
}

function convertTaggedJsx(
  contents: string,
  mode: TaggedJsxMode,
  transformers: TaggedJsxTransformers,
): {
  code: string;
  errors: string[];
} {
  const result = mode === "toJsx" ? transformers.toJsx(contents) : transformers.toTagged(contents);

  return {
    code: result.code,
    errors: (result.errors ?? []).map((error) => String(error)),
  };
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
function createPackageResolver(reader: WorkspaceReader): PackageResolver {
  const packageJsonCache = new Map<string, Promise<PackageJson | undefined>>();

  async function readPackageJson(packageDirectory: string): Promise<PackageJson | undefined> {
    const packageJsonPath = getPackageJsonPath(packageDirectory);

    const existing = packageJsonCache.get(packageJsonPath);

    if (existing != null) {
      return existing;
    }

    const pending = reader.readText(packageJsonPath).then((text) => {
      if (text == null) {
        return undefined;
      }

      return parseJsonSafe(text);
    });

    packageJsonCache.set(packageJsonPath, pending);

    return pending;
  }

  async function lookup(path: string): Promise<string | undefined> {
    const normalized = normalizePath(path);

    if ((await reader.readText(normalized)) != null) {
      return normalized;
    }

    if (hasFileExtension(normalized)) {
      return undefined;
    }

    for (const extension of COMPANION_EXTENSIONS) {
      const candidate = `${normalized}${extension}`;

      if ((await reader.readText(candidate)) != null) {
        return candidate;
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`;

      if ((await reader.readText(candidate)) != null) {
        return candidate;
      }
    }

    return undefined;
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

      if ((await reader.readText(packageJsonPath)) != null) {
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

    const manifestPath = `${packageDir}/package.json`;

    const manifestText = await reader.readText(manifestPath);
    const packageJson = manifestText != null ? parseJsonSafe(manifestText) : undefined;

    console.info("[esbuild] resolving package import", {
      specifier,
      packageDir,
      subpath,
      manifestPath,
      manifestFound: manifestText != null,
      hasExports: packageJson?.exports != null,
      exports: packageJson?.exports,
    });

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
  const normalized = normalizePath(path);

  if ((await reader.readText(normalized)) != null) {
    return normalized;
  }

  if (hasFileExtension(normalized)) {
    return undefined;
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const candidate = `${normalized}${extension}`;

    if ((await reader.readText(candidate)) != null) {
      return candidate;
    }
  }

  for (const trail of INDEX_TRAILS) {
    const candidate = `${normalized}${trail}`;

    if ((await reader.readText(candidate)) != null) {
      return candidate;
    }
  }

  return undefined;
}

function createWorkspaceFsPlugin(
  reader: WorkspaceReader,
  externalPaths: string[],
  unresolvedImports: Set<string>,
  taggedJsxRequest: TaggedJsxMode = "off",
): esbuild.Plugin {
  return {
    name: "dataverse-ide-workspace-fs",

    setup(build) {
      const packageResolver = createPackageResolver(reader);

      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === "entry-point") {
          return {
            path: normalizePath(args.path),
            namespace: "workspace",
          };
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
            return {
              path: resolved,
              namespace: "workspace",
            };
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
            return {
              path: resolved,
              namespace: "workspace",
            };
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

        const resolved = await resolveRelativeWorkspacePath(reader, joined);

        if (resolved != null) {
          return {
            path: resolved,
            namespace: "workspace",
          };
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
          let contents = await reader.readText(normalizedPath);

          if (contents == null) {
            return {
              errors: [
                {
                  text: `File not found in workspace: "${normalizedPath}".`,
                },
              ],
            };
          }

          let loader = getLoaderForPath(normalizedPath);

          /*
           * Tagged JSX transforms apply only to workspace source files.
           * node_modules content is already authored/compiled by the package
           * publisher and should remain untouched.
           */
          if (
            taggedJsxRequest !== "off" &&
            isWorkspaceSourcePath(normalizedPath) &&
            isTaggedJsxCandidate(loader)
          ) {
            try {
              const transformers = await ensureTaggedJsxTransformers();

              const converted = convertTaggedJsx(contents, taggedJsxRequest, transformers);

              if (converted.code !== contents) {
                contents = converted.code;
                loader = transformTaggedJsxLoader(loader, true);
              }

              if (converted.errors.length > 0) {
                return {
                  contents,
                  loader,
                  errors: converted.errors.slice(0, 8).map((text) => ({
                    text,
                  })),
                };
              }
            } catch (error) {
              return {
                contents,
                loader,
                errors: [
                  {
                    text: `taggedJsx transform failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                ],
              };
            }
          }

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

export async function runBuild(request: BuildRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized();

    const unresolvedImports = new Set<string>();

    const reader = withVirtualFiles(request.workspace, request.virtualFiles);

    const entryPoint = normalizePath(request.entry);
    const entryDirectory = entryPoint.includes("/")
      ? entryPoint.slice(0, entryPoint.lastIndexOf("/"))
      : ".";

    const taggedJsx = request.taggedJsx ?? "off";
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
          readText: (path) => reader.readText(path),
          sourcemap: request.sourcemap != null && request.sourcemap !== false,
          beforeTransform:
            taggedJsx === "off"
              ? undefined
              : async (source) => {
                  const transformers = await ensureTaggedJsxTransformers();

                  const converted = convertTaggedJsx(source, taggedJsx, transformers);

                  return { code: converted.code, errors: converted.errors };
                },
        }),
      );
    }

    plugins.push(
      createWorkspaceFsPlugin(reader, request.external ?? [], unresolvedImports, taggedJsx),
    );

    const result = await esbuild.build({
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
      plugins,
      /*
       * Keep the entry's own directory out of the output path, so
       * "src/app.ts" still writes "app.js" (plus sibling chunks/maps).
       */
      outbase: entryDirectory,
      outdir: "out",
    });

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
      outputs: result.outputFiles
        .filter((file) => file.contents != null)
        .map((file) => ({
          path: file.path,
          text: file.text,
        })),
      warnings,
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatLocation(location: { file?: string; line?: number; column?: number }): string {
  return `${location.file ?? ""}:${location.line ?? 0}:${location.column ?? 0}`;
}
