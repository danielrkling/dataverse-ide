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

  /*
   * Tagged JSX plugin (@tagged-jsx/transform), applied to workspace source
   * files on load: "toJsx" converts html`...` templates to JSX (then the
   * normal TS/JSX loaders + any downstream JSX tooling transpile it),
   * "toTagged" converts JSX to templates so you can write JSX and ship the
   * no-build-step runtime. Defaults to "off".
   */
  taggedJsx?: TaggedJsxMode;
};

export type TaggedJsxMode = "off" | "toJsx" | "toTagged";

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

/*
 * Tagged JSX plugin (@tagged-jsx/transform): Transformers are created once
 * per worker (both directions) and memoized; the TypeScript compiler module
 * they require is dynamically imported so builds that never enable the
 * plugin don't pay for it (~3.6 MB worker chunk).
 */
type TaggedJsxTransformers = {
  toJsx: (code: string) => { code: string; errors: unknown[] };
  toTagged: (code: string) => { code: string; errors: unknown[] };
};

let taggedJsxTransformersPromise: Promise<TaggedJsxTransformers> | undefined;

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

/*
 * Source-loadable file types the plugin may rewrite. After a successful
 * conversion the content's syntax class changes (html template -> JSX), so
 * the esbuild loader is upgraded too: TS-family content loaded through the
 * tsx loader, JS through the jsx loader (both accept JSX-free sources).
 */
function transformTaggedJsxLoader(currentLoader: esbuild.Loader, changed: boolean): esbuild.Loader {
  if (!changed) {
    return currentLoader;
  }

  if (currentLoader === "ts") {
    return "tsx";
  }

  if (currentLoader === "js") {
    return "jsx";
  }

  return currentLoader;
}

function isTaggedJsxCandidate(loader: esbuild.Loader): boolean {
  return loader === "ts" || loader === "tsx" || loader === "js" || loader === "jsx";
}

function convertTaggedJsx(
  contents: string,
  mode: TaggedJsxMode,
  transformers: TaggedJsxTransformers,
): { code: string; errors: string[] } {
  if (mode === "toJsx") {
    const result = transformers.toJsx(contents);

    return {
      code: result.code,
      errors: result.errors.map((error) => String(error)),
    };
  }

  const result = transformers.toTagged(contents);

  return {
    code: result.code,
    errors: result.errors.map((error) => String(error)),
  };
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

function isVirtualModulePath(path: string): boolean {
  return path.startsWith("__") || path.includes("node_modules") || path.startsWith("/node_modules");
}

function createVirtualFsPlugin(
  files: Record<string, string>,
  externalPaths: string[],
  absentPaths: Set<string>,
  reportMissing: (path: string) => void,
  unresolvedBareImports: Set<string>,
  taggedJsxRequest: TaggedJsxMode = "off",
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
      const taggedJsxMode = taggedJsxRequest;

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
         * cannot satisfy; probe candidates against the IMPORTER-JOINED path
         * (the raw specifier like "./core/error.js" would be probed against
         * the workspace root, so the lazy-request loop read garbage paths
         * and never asked for the real file - see TODO "esbuild worker:
         * lazy resolution never fetched package-internal relative
         * imports"). Chevron: preserves CSS import behavior where possible.
         */
        missingProbeCandidates(joined);

        /*
         * Fall through non-fatally with the importer-joined path marked
         * external: returning a bare relative path (no namespace in the
         * virtual namespace) makes esbuild abort the WHOLE build with
         * "Plugin returned a non-absolute path", and that destroys the
         * pending missing-probe list in the same round - exactly one round
         * before the joined-path probe would have surfaced the real file.
         * The next round reads the fetched sibling and the import binds.
         */
        if (args.path.startsWith(".")) {
          unresolvedBareImports.add(
            `Relative import "${args.path}" imported by "${args.importer || "<entry point>"}" ` +
              "was not found in the virtual filesystem and was left external in the output.",
          );
        }

        return {
          path: joined,
          external: true,
        };
      });

      build.onLoad(
        {
          filter: /.*/,
          namespace: "virtual",
        },
        async (args) => {
          const normalizedPath = normalizePath(args.path);
          let contents = files[normalizedPath];

          if (contents == null) {
            const available = fileNames.slice(0, 12).join(", ");

            return {
              errors: [
                {
                  text:
                    `File not found in workspace: "${normalizedPath}" ` +
                    `(available: ${available}…).`,
                },
              ],
            };
          }

          let loader = getLoaderForPath(normalizedPath);

          /*
           * Tagged JSX plugin: rewrite workspace source files before the
           * loaders. node_modules content is untouched (it ships compiled
           * code); only files esbuild may transpile as TS/JS(x) are
           * candidates. Transform failures surface as errors attributed to
           * the current file (esbuild's onLoad context) after the original
           * content, so the source still round-trips to the loader.
           */
          if (
            taggedJsxMode !== "off" &&
            !isVirtualModulePath(normalizedPath) &&
            isTaggedJsxCandidate(loader)
          ) {
            try {
              const transformers = await ensureTaggedJsxTransformers();
              const converted = convertTaggedJsx(contents, taggedJsxMode, transformers);

              if (converted.code !== contents) {
                contents = converted.code;
                loader = transformTaggedJsxLoader(loader, true);
              }

              if (converted.errors.length > 0) {
                return {
                  contents,
                  loader,
                  errors: converted.errors.slice(0, 8).map((text) => ({ text })),
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
          request.taggedJsx ?? "off",
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
