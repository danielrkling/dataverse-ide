/*
 * rollup bundle core: runs the @rollup/browser bundler on the main thread
 * over a virtual filesystem backed by vscode.workspace.fs.
 *
 * There is no workspace-wide collection pass and no lazy needFiles loop:
 * Rollup asks for an import, the resolver checks the mounted workspace, and
 * the load hook reads only that file. This is the same design as the
 * main-thread esbuild extension.
 *
 * Plugins:
 *   - virtual-fs        resolve/load workspace + node_modules files
 *   - esbuild transform TS/JSX lowering + define substitution
 *   - CSS asset         collect stylesheets into bundle.css
 *   - esbuild renderChunk minification (sourcemap chains through Rollup)
 */

import type { Plugin, RollupOutput, SourceMapInput } from "@rollup/browser";

import { NODE_BUILTINS, normalizePath } from "../shared/packageResolver.js";

import {
  createPackageResolver,
  isConfiguredExternal,
  joinFromImporter,
  resolveRelativeWorkspacePath,
  type WorkspaceReader,
} from "./workspaceResolver.js";

import { transformForBundler } from "../esbuild/compiler.js";

export type BundleRequest = {
  /** Workspace-relative entry, e.g. src/index.ts. */
  entry: string;

  /** Direct workspace reader for this build. */
  workspace: WorkspaceReader;

  format?: "esm" | "iife" | "cjs" | "umd";
  minify?: boolean;
  sourcemap?: boolean;
  external?: string[];
  define?: Record<string, string>;
};

export type BundleOutputFile = {
  path: string;
  text: string;
};

export type BundleResponse =
  | {
      ok: true;
      pipeline: string;
      outputs: BundleOutputFile[];
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
    };

/*
 * Worker pipeline version, surfaced in build responses so the output
 * channel can prove which code is running (stale-bundle diagnosis).
 */
export const PIPELINE_VERSION = "2026-10-30.2-main-thread";

/*
 * @rollup/browser is imported on first build so activation stays light and
 * projects that never build don't load the parser wasm.
 */
let rollupModulePromise: Promise<typeof import("@rollup/browser")> | undefined;

async function ensureRollup(): Promise<typeof import("@rollup/browser")> {
  rollupModulePromise ??= import("@rollup/browser");

  return rollupModulePromise;
}

function inlineSourceMapComment(map: unknown): string {
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(map))));

  return `\n//# sourceMappingURL=data:application/json;base64,${encoded}`;
}

function jsonModule(contents: string): string {
  const parsed = JSON.parse(contents) as unknown;

  let code = `export default ${JSON.stringify(parsed)};`;

  if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        code += `\nexport const ${key} = ${JSON.stringify(value)};`;
      }
    }
  }

  return code;
}

function createVirtualFsPlugin(
  entryPath: string,
  reader: WorkspaceReader,
  externalPaths: string[],
  unresolvedImports: Set<string>,
  cssSources: Map<string, string>,
): Plugin {
  const packageResolver = createPackageResolver(reader);

  return {
    name: "dataverse-ide-rollup-virtual-fs",

    async resolveId(source, importer) {
      /*
       * Entry points must be claimed here; otherwise Rollup's default
       * resolver treats the relative path as an unresolved dependency.
       */
      if (source === entryPath && normalizePath(source) === entryPath) {
        return source;
      }

      if (isConfiguredExternal(normalizePath(source), externalPaths)) {
        return { id: source, external: true };
      }

      /*
       * Package-import aliases ("#…") resolve against the importer's
       * nearest package.json "imports" field.
       */
      if (source.startsWith("#")) {
        return packageResolver.resolvePackageImport(
          source.normalize("NFC"),
          (importer ?? entryPath).normalize("NFC"),
        );
      }

      /*
       * Bare imports: npm packages and Node builtins.
       */
      if (!source.startsWith(".") && !source.startsWith("/")) {
        if (NODE_BUILTINS.has(source) || source.startsWith("node:")) {
          return { id: source, external: true };
        }

        const resolved = await packageResolver.resolveBareImport(normalizePath(source));

        if (resolved != null) {
          return resolved;
        }

        unresolvedImports.add(`${source} imported by ${importer || "<entry point>"}`);

        return { id: source, external: true };
      }

      /*
       * Relative and workspace-root-relative imports.
       */
      const joined = joinFromImporter(importer ?? entryPath, source);
      const resolved = await resolveRelativeWorkspacePath(reader, joined);

      if (resolved != null) {
        return resolved;
      }

      unresolvedImports.add(
        `relative import "${source}" was not found in the workspace ` +
          `(imported by ${importer || "<entry point>"})`,
      );

      return { id: joined, external: true };
    },

    async load(id) {
      const normalizedPath = normalizePath(id);
      const contents = await reader.readText(normalizedPath);

      if (contents == null) {
        throw new Error(`File not found in workspace: "${normalizedPath}".`);
      }

      if (normalizedPath.endsWith(".css")) {
        /*
         * Rollup has no CSS pipeline. Record the stylesheet for the asset
         * plugin and keep a side-effect-free JS module so tree shaking
         * removes it from the bundle.
         */
        cssSources.set(normalizedPath, contents);

        return { code: `export default ${JSON.stringify(contents)};`, map: null };
      }

      if (normalizedPath.endsWith(".json")) {
        return { code: jsonModule(contents), map: null };
      }

      return contents;
    },
  };
}

function createTransformPlugin(request: BundleRequest): Plugin {
  const define = request.define ?? {};
  const hasDefine = Object.keys(define).length > 0;

  return {
    name: "dataverse-ide-rollup-transform",

    async transform(code, id) {
      const normalizedPath = normalizePath(id);

      /*
       * CSS/JSON are handled by the virtual-fs load hook. Plain JS only
       * needs the transformer when define replacement is configured.
       */
      if (normalizedPath.endsWith(".css") || normalizedPath.endsWith(".json")) {
        return null;
      }

      const lang = normalizedPath.slice(normalizedPath.lastIndexOf(".") + 1);

      if (!hasDefine && !["ts", "tsx", "mts", "cts", "jsx"].includes(lang)) {
        return null;
      }

      const result = await transformForBundler({
        filename: normalizedPath,
        source: code,
        ...(hasDefine ? { define } : {}),
        sourcemap: request.sourcemap === true,
        format: "esm",
      });

      if (result.code === code && result.map == null) {
        return null;
      }

      return {
        code: result.code,
        map: request.sourcemap === true ? (result.map as SourceMapInput) : null,
      };
    },
  };
}

function createMinifyPlugin(request: BundleRequest, format: string): Plugin {
  return {
    name: "dataverse-ide-rollup-minify",

    async renderChunk(code, chunk) {
      const result = await transformForBundler({
        filename: chunk.fileName,
        source: code,
        minify: true,
        sourcemap: request.sourcemap === true,
        ...(format === "es" ? { format: "esm" as const } : {}),
      });

      return {
        code: result.code,
        map: request.sourcemap === true ? (result.map as SourceMapInput) : null,
      };
    },
  };
}

function createCssAssetPlugin(cssSources: Map<string, string>): Plugin {
  return {
    name: "dataverse-ide-rollup-css",

    generateBundle() {
      if (cssSources.size === 0) {
        return;
      }

      this.emitFile({
        type: "asset",
        fileName: "bundle.css",
        source: [...cssSources.values()].join("\n"),
      });
    },
  };
}

const FORMAT_BY_CONFIG: Record<
  NonNullable<BundleRequest["format"]>,
  "es" | "cjs" | "iife" | "umd"
> = {
  esm: "es",
  iife: "iife",
  cjs: "cjs",
  umd: "umd",
};

export async function bundle(request: BundleRequest): Promise<BundleResponse> {
  const entryPath = normalizePath(request.entry);
  const unresolvedImports = new Set<string>();
  const cssSources = new Map<string, string>();

  try {
    const { rollup } = await ensureRollup();
    const format = FORMAT_BY_CONFIG[request.format ?? "esm"];

    const warnings: string[] = [];

    const bundleInstance = await rollup({
      input: entryPath,
      plugins: [
        createVirtualFsPlugin(
          entryPath,
          request.workspace,
          request.external ?? [],
          unresolvedImports,
          cssSources,
        ),
        createTransformPlugin(request),
        createCssAssetPlugin(cssSources),
        ...(request.minify === true ? [createMinifyPlugin(request, format)] : []),
      ],
      onwarn(warning) {
        warnings.push(
          warning.loc != null
            ? `${warning.message} (${warning.loc.file ?? ""}:${warning.loc.line}:${warning.loc.column})`
            : warning.message,
        );
      },
    });

    const entryBase =
      entryPath
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_$]/g, "_") ?? "bundle";

    let generated: RollupOutput;

    try {
      generated = await bundleInstance.generate({
        format,
        sourcemap: request.sourcemap === true,
        /*
         * iife/umd cannot code-split; Rollup requires a single chunk for
         * these formats. The default single-entry build is already one chunk;
         * this also makes dynamic imports work in those formats.
         */
        inlineDynamicImports: format === "iife" || format === "umd",
        entryFileNames: `${entryBase}.js`,
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name][extname]",
        /* UMD/IIFE bundles that export values need a global name. */
        name: entryBase,
      });
    } finally {
      await bundleInstance.close();
    }

    warnings.push(
      ...[...unresolvedImports]
        .sort()
        .map(
          (detail) =>
            `Could not resolve npm package "${detail}". ` +
            "It was left external in the output bundle.",
        ),
    );

    const outputs: BundleOutputFile[] = [];

    for (const outputEntry of generated.output) {
      if (outputEntry.type === "chunk") {
        let code = outputEntry.code;

        if (request.sourcemap === true && outputEntry.map != null) {
          code += inlineSourceMapComment(outputEntry.map);
        }

        outputs.push({
          path: outputEntry.fileName,
          text: code,
        });

        continue;
      }

      if (outputEntry.type === "asset") {
        outputs.push({
          path: outputEntry.fileName,
          text: typeof outputEntry.source === "string" ? outputEntry.source : "",
        });
      }
    }

    return {
      ok: true,
      pipeline: PIPELINE_VERSION,
      outputs,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
