/*
 * rolldown bundle core: runs the @rolldown/browser bundler over an
 * in-memory virtual filesystem with the shared package resolver.
 *
 * Separated from the worker (worker.ts) so the bundling logic can be
 * exercised by node sanity tests (tests/rolldownBundle.sanity.mjs) without
 * the `self` message plumbing.
 */

import { rolldown } from "@rolldown/browser";

import type { ModuleTypes, Plugin } from "@rolldown/browser";

import {
  NODE_BUILTINS,
  RESOLVABLE_EXTENSIONS,
  INDEX_TRAILS,
  createPackageResolver,
  hasFileExtension,
  normalizePath,
} from "../shared/packageResolver.js";

export type BundleCoreRequest = {
  entry: string;
  files: Record<string, string>;

  format?: "esm" | "iife" | "cjs" | "umd";
  minify?: boolean;
  sourcemap?: boolean;
  external?: string[];
  define?: Record<string, string>;

  /*
   * Lazy resolution: paths the caller has already proven unreadable. The
   * resolver skips reporting them, so a follow-up round finalizes instead
   * of asking for them again.
   */
  absentPaths?: string[];
};

export type BundleOutputFile = {
  path: string;
  text: string;
};

export type BundleCoreResponse =
  | {
      ok: true;
      pipeline: string;
      outputs: BundleOutputFile[];
      warnings: string[];

      /** Probe round: non-empty means outputs/warnings are provisional. */
      needFiles?: string[];
    }
  | {
      ok: false;
      error: string;
    };

/*
 * Worker pipeline version, surfaced in build responses so the output
 * channel can prove which worker code is running (stale-bundle diagnosis).
 */
export const PIPELINE_VERSION = "2026-10-29.1"; // initial browser-bundle pipeline

/*
 * Bundling: rolldown's built-in oxc handling for TS/TSX/JS/JSX, plus JSON
 * and CSS. Explicit mapping keeps node_modules ESM files behaving
 * identically to workspace files.
 */
export const MODULE_TYPES: ModuleTypes = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".css": "css",
  ".json": "json",
};

/*
 * Virtual filesystem JS plugin (rolldown JS-plugin container).
 *
 * Mirrors the esbuild worker's virtual-fs plugin: lazy missing-file probes
 * (probe rounds), unresolved bare imports externalized + reported (final
 * round), unresolved relative imports externalized + reported (probe round
 * pattern; the next round reads the joined path and binds normally).
 */
export function createVirtualFsPlugin(
  entryPath: string,
  files: Record<string, string>,
  externalPaths: string[],
  absentPaths: Set<string>,
  reportMissing: (path: string) => void,
  unresolvedImports: Set<string>,
): Plugin {
  const fileNames = Object.keys(files);

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
   * esbuild-style `external` semantics: an entry matches the exact import
   * path or any subpath beneath it.
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

  const packageResolver = createPackageResolver(files, reportMissing);

  return {
    name: "dataverse-ide-virtual-fs",

    resolveId(source, importer) {
      /*
       * Entry points must be claimed here (prototype gotcha: the binding's
       * background resolver does not handle plugin-virtual entries).
       */
      if (source === entryPath && normalizePath(source) === entryPath) {
        return source;
      }

      if (isConfiguredExternal(normalizePath(source))) {
        return { id: source, external: true };
      }

      /*
       * Package-import aliases ("#…") resolve against the importer's
       * nearest package.json "imports" field.
       */
      if (source.startsWith("#")) {
        const resolvedPackageImport = packageResolver.resolvePackageImport(
          source.normalize("NFC"),
          (importer ?? entryPath).normalize("NFC"),
        );

        if (resolvedPackageImport != null) {
          return resolvedPackageImport;
        }

        /*
         * Unresolved "#…": leave it to rolldown's handling; the request
         * either probes (manifest missing) or fails visibly.
         */
        missingProbeCandidates(source.replace(/^#/, ""));

        return null;
      }

      /*
       * Bare imports: npm packages and Node builtins.
       */
      if (!source.startsWith(".") && !source.startsWith("/")) {
        if (NODE_BUILTINS.has(source) || source.startsWith("node:")) {
          return { id: source, external: true };
        }

        const resolved = packageResolver.resolveBareImport(normalizePath(source));

        if (resolved != null) {
          return resolved;
        }

        /*
         * The manifest was likely not collected yet: the package resolver's
         * reportMissing already recorded probe candidates (package.json,
         * subpath extension variants) for the next round. Preserve the
         * import rather than failing the entire build; the build response
         * reports it so the user knows the output is not fully bundled.
         */
        unresolvedImports.add(`${source} imported by ${importer || "<entry point>"}`);

        return { id: source, external: true };
      }

      /*
       * Relative and workspace-root-relative imports.
       */
      const importerDir = importer?.normalize("NFC").includes("/")
        ? importer.split("/").slice(0, -1)
        : [];

      const joined = source.startsWith("/")
        ? normalizePath(source)
        : normalizePath([...importerDir, source].join("/"));

      const resolved = lookup(joined);

      if (resolved != null) {
        return resolved;
      }

      /*
       * Probe pattern (matches the esbuild worker): externalize the
       * relative import NON-fatally, record probe candidates, and let the
       * next lazy round read the real file from the workspace.
       */
      missingProbeCandidates(joined);

      unresolvedImports.add(
        `relative import "${source}" not yet resolvable ` + `from ${importer || "<entry point>"}`,
      );

      return { id: joined, external: true };
    },

    load(id) {
      const normalizedPath = normalizePath(id);
      const contents = files[normalizedPath];

      if (contents == null) {
        const available = fileNames.slice(0, 12).join(", ");

        throw new Error(
          `File not found in workspace: "${normalizedPath}" ` + `(available: ${available}…).`,
        );
      }

      return contents;
    },
  };
}

const FORMAT_BY_CONFIG: Record<
  NonNullable<BundleCoreRequest["format"]>,
  "es" | "cjs" | "iife" | "umd"
> = {
  esm: "es",
  iife: "iife",
  cjs: "cjs",
  umd: "umd",
};

export async function bundle(request: BundleCoreRequest): Promise<BundleCoreResponse> {
  const entryPath = normalizePath(request.entry);
  const absentPaths = new Set(request.absentPaths ?? []);
  const missingPaths = new Set<string>();
  const unresolvedImports = new Set<string>();

  const reportMissing = (path: string): void => {
    /*
     * Only report paths the caller could plausibly read next round;
     * absentPaths entries were already proven unreadable.
     */
    if (!absentPaths.has(path)) {
      missingPaths.add(path);
    }
  };

  try {
    const virtualFs = createVirtualFsPlugin(
      entryPath,
      request.files,
      request.external ?? [],
      absentPaths,
      reportMissing,
      unresolvedImports,
    );

    const bundleInstance = await rolldown({
      input: entryPath,
      platform: "browser",
      plugins: [virtualFs],
      moduleTypes: MODULE_TYPES,

      /*
       * Build-time constants (oxc transform define). Only passed when the
       * config defines anything.
       */
      ...(Object.keys(request.define ?? {}).length > 0
        ? { transform: { define: request.define } }
        : {}),
    });

    const generated = await bundleInstance.generate({
      format: FORMAT_BY_CONFIG[request.format ?? "esm"],
      sourcemap: request.sourcemap === true ? "inline" : false,
      minify: request.minify === true,
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
        ok: true,
        pipeline: PIPELINE_VERSION,
        outputs: [],
        warnings: [],
        needFiles,
      };
    }

    const warnings = [
      ...[...unresolvedImports]
        .sort()
        .map(
          (detail) =>
            `Could not resolve npm package "${detail}". ` +
            "It was left external in the output bundle.",
        ),
    ];

    const outputs: BundleOutputFile[] = [];

    for (const outputEntry of generated.output) {
      if (outputEntry.type === "chunk") {
        outputs.push({
          path: outputEntry.fileName,
          text: outputEntry.code,
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
    let message = "Build failed.";

    if (typeof error === "string") {
      message = error;
    } else if (error instanceof Error) {
      message = error.message;
    }

    return {
      ok: false,
      error: message,
    };
  }
}
