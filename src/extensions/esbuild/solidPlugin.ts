/*
 * Solid JSX compiler plugin for the main-thread esbuild build.
 *
 * Solid 2.x ships two compilers:
 *
 *   - @solidjs/compiler (native / wasm) - used by vite-plugin-solid by default
 *   - @solidjs/babel-plugin            - the Babel implementation, still
 *                                        maintained and documented for 2.x
 *
 * Solid 1.x only has the Babel route (babel-preset-solid). This module wraps
 * both behind one esbuild plugin + one config option ("solid": "v1" | "v2"),
 * so the IDE no longer needs the @solidjs/compiler-wasm32-wasi WASI glue
 * (postinstall patches, worker pools, virtual wasm URLs) for esbuild builds.
 *
 * The Babel packages are loaded lazily on the first Solid build, the same way
 * the tagged-JSX transform loads TypeScript: builds that do not enable
 * "solid" never pay for the ~460 KB gzip Babel chunk.
 */

import type * as esbuild from "esbuild-wasm";

export type SolidCompilerVersion = "v1" | "v2";

export type SolidSourceCompileOptions = {
  version: SolidCompilerVersion;
  /** Workspace-relative path, e.g. "src/App.tsx". Used for diagnostics + maps. */
  filename: string;
  /** Emit a Babel source map (chained into esbuild as an inline map). */
  sourcemap?: boolean;
  /** Solid "dev" compilation output (source names / owner paths). */
  dev?: boolean;
};

export type SolidSourceCompileResult = {
  code: string;
  map?: object;
};

export type SolidPluginOptions = {
  version: SolidCompilerVersion;
  /** Reads workspace-relative text (vscode.workspace.fs backed in the IDE). */
  readText: (path: string) => Promise<string | undefined>;

  /**
   * Runs before the Solid compile. Used to compose the tagged-JSX transform
   * (toJsx introduces JSX, toTagged removes it before Solid sees the file).
   * Returning errors aborts the file load with attributed esbuild errors.
   */
  beforeTransform?: (
    source: string,
    path: string,
  ) => Promise<{ code: string; errors?: string[] } | undefined>;

  sourcemap?: boolean;
  dev?: boolean;
};

type BabelApi = typeof import("@babel/core");

type LoadedSolidCompiler = {
  babel: BabelApi;
  /** @solidjs/babel-plugin (v2) or babel-preset-solid (v1). */
  compiler: unknown;
  presetTypeScript: unknown;
};

const compilerCache = new Map<SolidCompilerVersion, Promise<LoadedSolidCompiler>>();

/*
 * Both Babel packages are CommonJS. Depending on the bundler (Vite dev
 * pre-bundling vs. the production build vs. plain Node in the sanity test),
 * the callable preset/plugin can land on `default` or on the namespace
 * itself, so unwrap defensively.
 */
function cjsDefault<T>(module: unknown): T {
  const record = module as { default?: T };

  return record.default ?? (module as T);
}

function loadSolidCompiler(version: SolidCompilerVersion): Promise<LoadedSolidCompiler> {
  let pending = compilerCache.get(version);

  if (pending == null) {
    pending = (async () => {
      const [babelModule, compilerModule, presetTypeScriptModule] = await Promise.all([
        import("@babel/core"),
        version === "v2" ? import("@solidjs/babel-plugin") : import("babel-preset-solid"),
        import("@babel/preset-typescript"),
      ]);

      return {
        babel: cjsDefault<BabelApi>(babelModule),
        compiler: cjsDefault<unknown>(compilerModule),
        presetTypeScript: cjsDefault<unknown>(presetTypeScriptModule),
      };
    })();

    compilerCache.set(version, pending);
  }

  return pending;
}

function isTypeScriptFile(path: string): boolean {
  return /\.[mc]?tsx?$/i.test(path);
}

function isTsxFile(path: string): boolean {
  return /\.tsx$/i.test(path);
}

function compilerOptions(version: SolidCompilerVersion, dev: boolean): Record<string, unknown> {
  if (version === "v2") {
    return {
      moduleName: "@solidjs/web",
      generate: "dom",
      hydratable: false,
      dev,
    };
  }

  /*
   * babel-preset-solid@1.x defaults to solid-js/web; keep that default
   * (moduleName is intentionally omitted so a future 1.x default change
   * still applies).
   */
  return {
    generate: "dom",
    hydratable: false,
    dev,
  };
}

/*
 * Babel returns the map as a plain object. esbuild plugins cannot return a
 * separate map from onLoad, but esbuild does chain maps that are embedded in
 * the loaded contents as a data URL.
 */
function withInlineSourceMap(code: string, map: object): string {
  const json = JSON.stringify(map);
  const bytes = new TextEncoder().encode(json);

  let binary = "";

  /*
   * Chunked String.fromCharCode keeps the argument list small for large
   * modules (sourcesContent makes the map roughly the size of the source).
   */
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }

  return `${code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${btoa(binary)}\n`;
}

function babelErrorLocation(
  error: unknown,
  filename: string,
): { file: string; line: number; column: number } | undefined {
  const loc = (error as { loc?: { line?: number; column?: number } } | undefined)?.loc;

  if (loc?.line == null) {
    return undefined;
  }

  return {
    file: filename,
    line: loc.line,
    column: Math.max(0, loc.column ?? 0),
  };
}

function toEsbuildError(
  error: unknown,
  version: SolidCompilerVersion,
  filename: string,
): esbuild.PartialMessage {
  const message = error instanceof Error ? error.message : String(error);

  return {
    text: `[solid:${version}] ${stripBabelFilename(message, filename)}`,
    location: babelErrorLocation(error, filename),
  };
}

/*
 * Babel prefixes plugin errors with the resolved absolute filename
 * ("C:\src\App.tsx: ..." on Windows, "/src/App.tsx" in the browser). The
 * workspace path is already attached to the esbuild error, so drop the
 * duplicate prefix when it matches this file.
 */
function stripBabelFilename(message: string, filename: string): string {
  const separator = message.indexOf(": ");

  if (separator <= 0) {
    return message;
  }

  const head = message.slice(0, separator).replaceAll("\\", "/");
  const normalized = filename.replaceAll("\\", "/");

  if (head.endsWith(normalized) || head.endsWith(`/${normalized}`)) {
    return message.slice(separator + 2);
  }

  return message;
}

/**
 * Compiles one Solid JSX/TSX module with the requested Babel compiler.
 *
 * Exported separately from the esbuild plugin so other bundler integrations
 * (and the Node sanity harness) can reuse the exact same configuration.
 */
export async function compileSolidSource(
  source: string,
  options: SolidSourceCompileOptions,
): Promise<SolidSourceCompileResult> {
  const { babel, compiler, presetTypeScript } = await loadSolidCompiler(options.version);

  const typescript = isTypeScriptFile(options.filename);
  const tsx = isTsxFile(options.filename);
  const dev = options.dev ?? false;

  const optionsForCompiler = compilerOptions(options.version, dev);

  /*
   * Solid 2.x is a Babel plugin; Solid 1.x (babel-preset-solid) is a Babel
   * preset. They cannot share one slot in the Babel options.
   */
  const solidPresets = options.version === "v1" ? [[compiler as object, optionsForCompiler]] : [];
  const solidPlugins = options.version === "v2" ? [[compiler as object, optionsForCompiler]] : [];

  const result = babel.transformSync(source, {
    filename: options.filename,
    sourceFileName: options.filename,

    /*
     * The IDE has no meaningful process cwd and the browser build must not
     * depend on one. An explicit absolute root also keeps Babel's config
     * lookup from walking the (virtual) workspace.
     */
    cwd: "/",
    root: "/",
    configFile: false,
    babelrc: false,
    browserslistConfigFile: false,

    /*
     * @solidjs/babel-plugin does not strip TypeScript itself. The preset is
     * only needed for .ts/.tsx input; .jsx files stay untouched by it.
     */
    presets: [
      ...solidPresets,
      ...(typescript ? [[presetTypeScript as object, { isTSX: tsx, allExtensions: true }]] : []),
    ],

    plugins: solidPlugins,

    sourceMaps: options.sourcemap === true,
    ast: false,
    code: true,
    comments: true,
  });

  if (result == null || result.code == null) {
    throw new Error("The Solid compiler produced no output.");
  }

  const map = result.map as
    | (object & {
        sources?: string[];
        sourcesContent?: (string | null)[];
        file?: string;
      })
    | null;

  if (map != null) {
    map.sources = [options.filename];
    map.sourcesContent = [source];
    map.file = options.filename;
  }

  return {
    code: result.code,
    map: map ?? undefined,
  };
}

/**
 * Workspace source check shared with the bundler plugin: `node_modules` is
 * authored/compiled by package publishers, and `__` paths are virtual
 * generated modules.
 */
export function isWorkspaceSourcePath(path: string): boolean {
  return !path.startsWith("node_modules/") && !path.startsWith("__");
}

/**
 * esbuild plugin that compiles workspace `.jsx`/`.tsx` files to plain JS
 * before esbuild's own loaders run.
 *
 * Register it BEFORE the workspace-fs plugin: esbuild calls onLoad callbacks
 * in plugin order, and this plugin returns `undefined` for everything it does
 * not own (node_modules, virtual entries, non-JSX extensions), so the normal
 * workspace loader still handles those files.
 */
export function createSolidEsbuildPlugin(options: SolidPluginOptions): esbuild.Plugin {
  return {
    name: `dataverse-ide-solid-${options.version}`,

    setup(build) {
      build.onLoad(
        { filter: /\.[jt]sx$/, namespace: "workspace" },
        async (args): Promise<esbuild.OnLoadResult | undefined> => {
          const path = args.path.replaceAll("\\", "/");

          if (!isWorkspaceSourcePath(path)) {
            return undefined;
          }

          let source = await options.readText(path);

          if (source == null) {
            /* Let the workspace-fs plugin report the missing file. */
            return undefined;
          }

          if (options.beforeTransform != null) {
            const prepared = await options.beforeTransform(source, path);

            if (prepared != null) {
              source = prepared.code;

              if (prepared.errors != null && prepared.errors.length > 0) {
                return {
                  errors: prepared.errors.slice(0, 8).map((text) => ({
                    text,
                    location: { file: path, line: 1, column: 0 },
                  })),
                };
              }
            }
          }

          try {
            const compiled = await compileSolidSource(source, {
              version: options.version,
              filename: path,
              sourcemap: options.sourcemap,
              dev: options.dev,
            });

            return {
              contents:
                compiled.map != null
                  ? withInlineSourceMap(compiled.code, compiled.map)
                  : compiled.code,
              /*
               * Babel stripped JSX (and TypeScript, when applicable), so the
               * plain JS loader is correct.
               */
              loader: "js",
            };
          } catch (error) {
            return {
              errors: [toEsbuildError(error, options.version, path)],
            };
          }
        },
      );
    },
  };
}
