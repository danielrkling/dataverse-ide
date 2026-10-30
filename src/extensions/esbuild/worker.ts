/*
 * esbuild worker: runs the esbuild-wasm compiler off the main thread.
 *
 * Protocol (plain postMessage request/response):
 *   { id, type: 'build', entry, files, format?, minify?, sourcemap?,
 *     target?, bundle?, external?, define?, entryNames? }
 *   <- { id, ok, outputs }             (success)
 *   <- { id, ok: false, error }        (failure)
 *
 * Workspace source files and text-based npm package files are provided by
 * the main thread as an in-memory virtual filesystem.
 */

/*
 * The wasm binary is embedded at build time through the
 * `virtual:esbuild-wasm-binary` module (vite.config.ts): Dataverse web
 * resources cannot host separate .wasm files. The binary is compiled with
 * `new WebAssembly.Module()` synchronously - legal in a worker - and handed
 * to esbuild-wasm through its `wasmModule` option.
 */
import * as esbuild from "esbuild-wasm";
import wasmBase64 from "virtual:esbuild-wasm-binary";

/*
 * The package resolver (bare imports via package.json exports/imports, the
 * lazy-probe callback protocol) is shared with the rolldown worker.
 */
import {
  COMPANION_EXTENSIONS,
  INDEX_TRAILS,
  NODE_BUILTINS,
  RESOLVABLE_EXTENSIONS,
  createPackageResolver,
  hasFileExtension,
  normalizePath,
} from "../shared/packageResolver.js";

type BuildRequest = {
  id: number;
  type: "build";
  entry: string;
  files: Record<string, string>;
  format?: "esm" | "iife" | "cjs";
  minify?: boolean;
  sourcemap?: boolean;
  target?: string;

  /*
   * Bundle module graph (default true); false means transpile-only.
   */
  bundle?: boolean;

  /*
   * Bare import paths intentionally left in output.
   *
   * Example:
   *   ["react", "@dataverse/web-api"]
   */
  external?: string[];

  /*
   * Build-time constants.
   *
   * Example:
   *   { "process.env.NODE_ENV": "\"production\"" }
   */
  define?: Record<string, string>;

  /*
   * Lazy resolution: paths the caller has already proven unreadable (absent
   * on the filesystem). The resolver skips recording them as needed files,
   * so a follow-up round finalizes instead of asking for them again.
   */
  absentPaths?: string[];

  /*
   * Entry-relative or workspace-relative pattern such as "[dir]/[name]".
   */
  entryNames?: string;
};

type TransformRequest = {
  id: number;
  type: "transform";
  filename: string;
  source: string;
  minify?: boolean;
};

export type WorkerRequest = BuildRequest | TransformRequest;

export type BuildOutputFile = {
  path: string;
  text: string;
};

type BuildSuccessResponse = {
  id: number;
  ok: true;
  outputs: BuildOutputFile[];
  warnings: string[];

  /*
   * Lazy resolution round: paths the resolver needed but the files map did
   * not contain. Non-empty means this is a PROBE round â€” outputs/warnings
   * are empty and the caller should read these paths from the workspace and
   * send the build request again (merging files, marking unreadable paths
   * in absentPaths).
   */
  needFiles?: string[];
};

type BuildFailureResponse = {
  id: number;
  ok: false;
  error: string;
};

type BuildResponse = BuildSuccessResponse | BuildFailureResponse;

let initialization: Promise<void> | undefined;

async function ensureInitialized(): Promise<void> {
  if (initialization == null) {
    initialization = (async () => {
      const bytes = Uint8Array.from(atob(wasmBase64), (character) => character.charCodeAt(0));

      const wasmModule = new WebAssembly.Module(bytes);

      await esbuild.initialize({
        wasmModule,
        worker: false,
      });
    })();
  }

  await initialization;
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

function createVirtualFsPlugin(
  files: Record<string, string>,
  externalPaths: string[],
  absentPaths: Set<string>,
  reportMissing: (path: string) => void,
  unresolvedBareImports: Set<string>,
): esbuild.Plugin {
  const fileNames = Object.keys(files);

  /*
   * Lazy resolution: record candidate paths the resolver needed but could
   * not find in the map (unless a previous round already proved them
   * absent), so the main thread can read them from the workspace and top
   * the map up in the next round.
   */
  function missingProbeCandidates(path: string): void {
    const normalized = normalizePath(path);

    if (files[normalized] != null || absentPaths.has(normalized)) {
      return;
    }

    reportMissing(normalized);

    if (hasFileExtension(normalized)) {
      return;
    }

    for (const extension of RESOLVABLE_EXTENSIONS) {
      const candidate = `${normalized}${extension}`;

      if (extension.length > 0 && !absentPaths.has(candidate)) {
        reportMissing(candidate);
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`;

      if (!absentPaths.has(candidate)) {
        reportMissing(candidate);
      }
    }
  }

  /*
   * Mirror esbuild's own `external` semantics: an entry matches the exact
   * import path or any subpath beneath it, so `external: ["lodash"]` also
   * leaves `lodash/fp` external. Checked before any other resolution so a
   * user-configured external is never accidentally captured by the
   * virtual filesystem's package resolver.
   */
  function isConfiguredExternal(path: string): boolean {
    return externalPaths.some((external) => path === external || path.startsWith(`${external}/`));
  }

  function lookup(path: string): string | undefined {
    const normalized = normalizePath(path);

    if (files[normalized] != null) {
      return normalized;
    }

    for (const extension of RESOLVABLE_EXTENSIONS) {
      const candidate = `${normalized}${extension}`;

      if (files[candidate] != null) {
        return candidate;
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`;

      if (files[candidate] != null) {
        return candidate;
      }
    }

    return undefined;
  }

  return {
    name: "dataverse-ide-virtual-fs",

    setup(build) {
      const packageResolver = createPackageResolver(files, reportMissing);

      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return {
            path: normalizePath(args.path),
            namespace: "virtual",
          };
        }

        if (isConfiguredExternal(args.path)) {
          return {
            path: args.path,
            external: true,
          };
        }

        /*
         * Package-import aliases ("#â€¦") resolve against the importer's
         * nearest package.json "imports" field.
         */
        if (args.path.startsWith("#")) {
          const resolvedPackageImport = packageResolver.resolvePackageImport(
            args.path.normalize("NFC"),
            args.importer.normalize("NFC"),
          );

          if (resolvedPackageImport != null) {
            return {
              path: resolvedPackageImport,
              namespace: "virtual",
            };
          }

          /*
           * Unresolved "#â€¦": let esbuild decide whether another
           * plugin/setting can resolve them; otherwise the build fails
           * visibly instead of silently externalizing.
           */
          return undefined;
        }

        /*
         * Bare imports: npm packages and Node builtins.
         */
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          if (NODE_BUILTINS.has(args.path) || args.path.startsWith("node:")) {
            return {
              path: args.path,
              external: true,
            };
          }

          const resolved = packageResolver.resolveBareImport(normalizePath(args.path));

          if (resolved != null) {
            return {
              path: resolved,
              namespace: "virtual",
            };
          }

          /*
           * Preserve the import rather than failing the entire build, but
           * report it in the build response so the user knows the output is
           * not fully bundled.
           */
          unresolvedBareImports.add(`${args.path} imported by ${args.importer || "<entry point>"}`);

          return {
            path: args.path,
            external: true,
          };
        }

        /*
         * Relative and workspace-root-relative imports.
         */
        const importerDir = args.importer.normalize("NFC").includes("/")
          ? args.importer.split("/").slice(0, -1)
          : [];

        const joined = args.path.startsWith("/")
          ? normalizePath(args.path)
          : normalizePath([...importerDir, args.path].join("/"));

        const resolved = lookup(joined);

        if (resolved != null) {
          return {
            path: resolved,
            namespace: "virtual",
          };
        }

        /*
         * Let esbuild continue resolution for paths the virtual filesystem
         * cannot satisfy. This preserves CSS import behavior where possible.
         */
        missingProbeCandidates(args.path);

        return {
          path: args.path,
        };
      });

      build.onLoad(
        {
          filter: /.*/,
          namespace: "virtual",
        },
        (args) => {
          const normalizedPath = normalizePath(args.path);
          const contents = files[normalizedPath];

          if (contents == null) {
            const available = fileNames.slice(0, 12).join(", ");

            return {
              errors: [
                {
                  text:
                    `File not found in workspace: "${normalizedPath}" ` +
                    `(available: ${available}â€¦).`,
                },
              ],
            };
          }

          return {
            contents,
            loader: getLoaderForPath(normalizedPath),
          };
        },
      );
    },
  };
}

async function transform(request: TransformRequest): Promise<BuildResponse> {
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

async function build(request: BuildRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized();

    const unresolvedBareImports = new Set<string>();
    const absentPaths = new Set(request.absentPaths ?? []);
    const missingPaths = new Set<string>();

    const reportMissing = (path: string): void => {
      /*
       * Only report paths the caller could plausibly read next round;
       * absentPaths entries were already proven unreadable.
       */
      if (!absentPaths.has(path)) {
        missingPaths.add(path);
      }
    };

    const result = await esbuild.build({
      entryPoints: [normalizePath(request.entry)],
      bundle: request.bundle ?? true,
      write: false,
      format: request.format ?? "esm",
      minify: request.minify ?? false,
      sourcemap: request.sourcemap ?? false,
      target: request.target ?? "es2022",
      external: request.external,
      define: request.define,
      entryNames: request.entryNames,
      logLevel: "silent",
      plugins: [
        createVirtualFsPlugin(
          request.files,
          request.external ?? [],
          absentPaths,
          reportMissing,
          unresolvedBareImports,
        ),
      ],
      outbase: ".",
      outdir: "out",
    });

    const needFiles = [...missingPaths]
      .filter((path) => request.files[path] == null && !absentPaths.has(path))
      .sort();

    if (needFiles.length > 0) {
      /*
       * Probe round: the resolver needed files the caller has not provided
       * yet. The outputs of this build are not final (unresolved imports
       * were externalized), so return the requested paths instead.
       */
      return {
        id: request.id,
        ok: true,
        outputs: [],
        warnings: [],
        needFiles,
      };
    }

    const warnings = [
      ...result.warnings.map(
        (warning) =>
          `${warning.text}${
            warning.location != null ? ` (${formatLocation(warning.location)})` : ""
          }`,
      ),

      ...[...unresolvedBareImports]
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
    let message = "Build failed.";

    if (typeof error === "string") {
      message = error;
    } else if (error instanceof Error) {
      message = error.message;
    }

    return {
      id: request.id,
      ok: false,
      error: message,
    };
  }
}

function formatLocation(location: { file?: string; line?: number; column?: number }): string {
  return `${location.file ?? ""}:${location.line ?? 0}:${location.column ?? 0}`;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const request = event.data;

  if (request == null || request.type == null || request.id == null) {
    return;
  }

  const response = request.type === "build" ? await build(request) : await transform(request);

  self.postMessage(response);
};
