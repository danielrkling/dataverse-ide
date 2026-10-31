/*
 * Async module loader for the direct-fs runtime.
 *
 * Phase 1 (async): resolve the reachable import graph through
 * vscode.workspace.fs, transpile each module to CommonJS and cache its code.
 * Phase 2 (sync): execute the graph with a synchronous require() served
 * from that cache, exactly like Node's CommonJS loader.
 *
 * Anything the static pass could not see (dynamic require of a computed
 * path, or a sync fs read of a data file) throws a typed miss; the engine
 * hydrates that path asynchronously and retries the run.
 */

import type { Process } from "almostnode";

import { Buffer } from "buffer";

import { hasFileExtension, parseJsonSafe } from "../shared/packageResolver.js";
import { createPackageResolver } from "../rollup/workspaceResolver.js";

import { createBuiltins, type Builtins, type RequireFunction } from "./builtins.js";
import { MissingPathError, type RuntimeFs } from "./fsShim.js";
import { collectModuleSpecifiers, transpileModule } from "./transpile.js";
import { dirname, joinPath, normalizePath, type WorkspaceFs } from "./workspace.js";

const COMPANION_EXTENSIONS = [
  "",
  ".js",
  ".json",
  ".node",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

const INDEX_TRAILS = [
  "/index.js",
  "/index.json",
  "/index.mjs",
  "/index.cjs",
  "/index.jsx",
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
];

/*
 * TypeScript sources usually import their siblings with the emitted ".js"
 * extension. When the ".js" file does not exist, try the TS companions.
 */
const EXTENSION_SWAPS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".mts", ".cts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export class MissingModuleError extends Error {
  constructor(
    readonly specifier: string,
    readonly fromDir: string,
  ) {
    super(`Module "${specifier}" from "${fromDir || "/"}" was not loaded yet.`);
    this.name = "MissingModuleError";
  }
}

type ModuleRecord = {
  path: string;
  source: string;
  code: string;
  json: boolean;
};

type RuntimeModule = {
  id: string;
  filename: string;
  exports: unknown;
  loaded: boolean;
  children: RuntimeModule[];
  paths: string[];
};

export type ModuleLoader = {
  run: (entry: string) => Promise<unknown>;
  dispose: () => void;
};

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function wrapEsm(exportsValue: unknown): unknown {
  if (
    exportsValue != null &&
    typeof exportsValue === "object" &&
    ("default" in exportsValue || "__esModule" in exportsValue)
  ) {
    return exportsValue;
  }

  if (exportsValue != null && typeof exportsValue === "object") {
    return { default: exportsValue, ...exportsValue };
  }

  return { default: exportsValue };
}

export function createModuleLoader(options: {
  reader: WorkspaceFs;
  runtimeFs: RuntimeFs;
  process: Process;
  onConsole?: (method: string, args: unknown[]) => void;
  onRetry?: (message: string) => void;
}): ModuleLoader {
  const { reader, runtimeFs, process } = options;

  const sourceCache = new Map<string, string | null>();
  const collected = new Map<string, ModuleRecord>();
  const collecting = new Set<string>();
  const resolutions = new Map<string, string | null>();
  const moduleCache: Record<string, RuntimeModule> = {};

  const packageResolver = createPackageResolver(reader);

  let builtins: Builtins;

  let entryModule: RuntimeModule | undefined;

  async function readSource(path: string): Promise<string | undefined> {
    const normalized = normalizePath(path);

    if (sourceCache.has(normalized)) {
      return sourceCache.get(normalized) ?? undefined;
    }

    const text = await reader.readText(normalized);

    sourceCache.set(normalized, text ?? null);

    return text;
  }

  async function lookup(base: string): Promise<string | undefined> {
    const normalized = normalizePath(base);

    if (normalized.length === 0) {
      return undefined;
    }

    if ((await readSource(normalized)) != null) {
      return normalized;
    }

    const swapped = EXTENSION_SWAPS[extensionOf(normalized)];

    if (swapped != null) {
      const stem = normalized.slice(0, normalized.lastIndexOf("."));

      for (const extension of swapped) {
        const candidate = `${stem}${extension}`;

        if ((await readSource(candidate)) != null) {
          return candidate;
        }
      }
    }

    if (!hasFileExtension(normalized)) {
      for (const extension of COMPANION_EXTENSIONS) {
        if (extension.length === 0) {
          continue;
        }

        const candidate = `${normalized}${extension}`;

        if ((await readSource(candidate)) != null) {
          return candidate;
        }
      }

      for (const trail of INDEX_TRAILS) {
        const candidate = `${normalized}${trail}`;

        if ((await readSource(candidate)) != null) {
          return candidate;
        }
      }
    }

    /*
     * Relative directory imports may point at a package.json "main" entry.
     * Bare imports use the package resolver below, which handles exports.
     */
    const manifest = await readSource(joinPath(normalized, "package.json"));

    if (manifest != null) {
      const packageJson = parseJsonSafe(manifest);

      for (const field of ["browser", "module", "main"]) {
        const target = packageJson?.[field];

        if (typeof target !== "string" || target.length === 0) {
          continue;
        }

        const resolved = await lookup(joinPath(normalized, target.replace(/^\.\//, "")));

        if (resolved != null) {
          return resolved;
        }
      }
    }

    return undefined;
  }

  async function resolveUncached(specifier: string, fromDir: string): Promise<string | undefined> {
    if (specifier.startsWith("#")) {
      const resolved = await packageResolver.resolvePackageImport(
        specifier,
        `${fromDir.length > 0 ? `${fromDir}/` : ""}__importer__.js`,
      );

      return resolved ?? undefined;
    }

    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? normalizePath(specifier)
        : joinPath(fromDir, specifier);

      return lookup(base);
    }

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
      throw new Error(`Unsupported module URL: ${specifier}`);
    }

    const resolved = await packageResolver.resolveBareImport(specifier);

    return resolved;
  }

  async function resolveAsync(specifier: string, fromDir: string): Promise<string | undefined> {
    if (builtins.has(specifier)) {
      return undefined;
    }

    const key = `${fromDir}|${specifier}`;

    if (resolutions.has(key)) {
      return resolutions.get(key) ?? undefined;
    }

    const resolved = await resolveUncached(specifier, fromDir);

    resolutions.set(key, resolved ?? null);

    return resolved;
  }

  async function collectModule(path: string): Promise<void> {
    const normalized = normalizePath(path);

    if (collected.has(normalized) || collecting.has(normalized)) {
      return;
    }

    collecting.add(normalized);

    try {
      const source = await readSource(normalized);

      if (source == null) {
        throw new Error(`Cannot read module '${normalized}'.`);
      }

      const extension = extensionOf(normalized);

      if (extension === ".node") {
        throw new Error(`Native addon '${normalized}' cannot be loaded in the browser.`);
      }

      if (extension === ".json") {
        collected.set(normalized, {
          path: normalized,
          source,
          code: "",
          json: true,
        });

        return;
      }

      let code: string;

      try {
        code = await transpileModule(normalized, source);
      } catch (error) {
        throw new Error(
          `Transpiling '${normalized}' failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }

      collected.set(normalized, {
        path: normalized,
        source,
        code,
        json: false,
      });

      for (const specifier of collectModuleSpecifiers(code)) {
        if (builtins.has(specifier)) {
          continue;
        }

        const resolved = await resolveAsync(specifier, dirname(normalized));

        if (resolved == null) {
          throw new Error(`Cannot find module '${specifier}' imported from '${normalized}'.`);
        }

        resolutions.set(`${dirname(normalized)}|${specifier}`, resolved);

        await collectModule(resolved);
      }
    } finally {
      collecting.delete(normalized);
    }
  }

  async function resolveEntry(entry: string): Promise<string | undefined> {
    return lookup(entry);
  }

  function candidatePaths(base: string): string[] {
    const candidates = [base];

    if (!hasFileExtension(base)) {
      for (const extension of COMPANION_EXTENSIONS) {
        if (extension.length > 0) {
          candidates.push(`${base}${extension}`);
        }
      }

      for (const trail of INDEX_TRAILS) {
        candidates.push(`${base}${trail}`);
      }
    } else {
      const swapped = EXTENSION_SWAPS[extensionOf(base)];

      if (swapped != null) {
        const stem = base.slice(0, base.lastIndexOf("."));

        for (const extension of swapped) {
          candidates.push(`${stem}${extension}`);
        }
      }
    }

    return candidates;
  }

  function resolveSync(specifier: string, fromDir: string): string | undefined {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      const base = specifier.startsWith("/")
        ? normalizePath(specifier)
        : joinPath(fromDir, specifier);

      return candidatePaths(base).find((candidate) => collected.has(candidate));
    }

    return undefined;
  }

  function createRequireAt(filename: string): RequireFunction {
    const fromDir = dirname(filename);

    const requireFunction = ((id: string): unknown => {
      if (builtins.has(id)) {
        return builtins.get(id);
      }

      const key = `${fromDir}|${id}`;
      let resolved = resolutions.get(key);

      if (resolved === undefined) {
        const syncResolved = resolveSync(id, fromDir);

        if (syncResolved != null) {
          resolutions.set(key, syncResolved);
          resolved = syncResolved;
        }
      }

      if (resolved == null) {
        throw new MissingModuleError(id, fromDir);
      }

      return executeModule(resolved).exports;
    }) as RequireFunction;

    requireFunction.resolve = (id: string): string => {
      if (builtins.has(id)) {
        return id;
      }

      const key = `${fromDir}|${id}`;
      const resolved = resolutions.get(key) ?? resolveSync(id, fromDir);

      if (resolved == null) {
        throw new MissingModuleError(id, fromDir);
      }

      return resolved;
    };

    requireFunction.cache = moduleCache as unknown as Record<string, unknown>;

    return requireFunction;
  }

  function executeModule(path: string): RuntimeModule {
    const normalized = normalizePath(path);
    const cached = moduleCache[normalized];

    if (cached != null) {
      return cached;
    }

    const record = collected.get(normalized);

    if (record == null) {
      throw new MissingModuleError(`./${normalized}`, "");
    }

    const module: RuntimeModule = {
      id: normalized,
      filename: normalized,
      exports: {},
      loaded: false,
      children: [],
      paths: [],
    };

    moduleCache[normalized] = module;

    if (entryModule == null) {
      entryModule = module;
    }

    try {
      if (record.json) {
        module.exports = JSON.parse(record.source);
        module.loaded = true;

        return module;
      }

      const directory = dirname(normalized);
      const requireFunction = createRequireAt(normalized);

      if (entryModule != null) {
        (requireFunction as unknown as { main?: RuntimeModule }).main = entryModule;
      }

      const importMeta = {
        url: `file:///${normalized}`,
        filename: normalized,
        dirname: directory,
      };

      const dynamicImport = async (specifier: string): Promise<unknown> => {
        if (builtins.has(specifier)) {
          return wrapEsm(builtins.get(specifier));
        }

        const resolved = await resolveAsync(specifier, directory);

        if (resolved == null) {
          throw new Error(`Cannot find module '${specifier}' imported from '${normalized}'.`);
        }

        await collectModule(resolved);

        return wrapEsm(executeModule(resolved).exports);
      };

      const wrapped = `(function($exports, $require, $module, $filename, $dirname, $process, $console, $Buffer, $global, $importMeta, $dynamicImport, $fetch) {
var exports = $exports;
var require = $require;
var module = $module;
var __filename = $filename;
var __dirname = $dirname;
var process = $process;
var console = $console;
var Buffer = $Buffer;
var global = $global;
var __importMeta = $importMeta;
var __dynamicImport = $dynamicImport;
var fetch = $fetch;
return (function() {
${record.code}
}).call(this);
})`;

      const factory = new Function(`return ${wrapped}`)() as (
        this: unknown,
        exportsValue: unknown,
        requireValue: RequireFunction,
        moduleValue: RuntimeModule,
        filename: string,
        dirnameValue: string,
        processValue: Process,
        consoleValue: Console,
        bufferValue: typeof Buffer,
        globalValue: typeof globalThis,
        importMetaValue: unknown,
        dynamicImportValue: (specifier: string) => Promise<unknown>,
        fetchValue: typeof fetch,
      ) => unknown;

      factory.call(
        module.exports,
        module.exports,
        requireFunction,
        module,
        normalized,
        directory,
        process,
        builtins.console,
        Buffer,
        globalThis,
        importMeta,
        dynamicImport,
        globalThis.fetch.bind(globalThis),
      );

      module.loaded = true;

      return module;
    } catch (error) {
      delete moduleCache[normalized];

      if (error instanceof Error && !error.message.includes("(in ")) {
        error.message = `${error.message} (in ${normalized})`;
      }

      throw error;
    }
  }

  async function collectMissingModule(specifier: string, fromDir: string): Promise<void> {
    const resolved = await resolveAsync(specifier, fromDir);

    if (resolved == null) {
      throw new Error(`Cannot find module '${specifier}' from '${fromDir || "/"}'.`);
    }

    resolutions.set(`${fromDir}|${specifier}`, resolved);
    await collectModule(resolved);
  }

  async function prepare(entry: string): Promise<string> {
    const normalized = normalizePath(entry);
    const resolved = await resolveEntry(normalized);

    if (resolved == null) {
      throw new Error(`Cannot find entry file '${entry}'.`);
    }

    await collectModule(resolved);

    return resolved;
  }

  builtins = createBuiltins({
    process,
    fs: runtimeFs.fs,
    fsPromises: runtimeFs.promises,
    createRequireAt,
    onConsole: options.onConsole,
  });

  return {
    async run(entry: string): Promise<unknown> {
      const resolved = await prepare(entry);
      const attempted = new Set<string>();

      process.argv = ["node", resolved];

      for (let attempt = 0; attempt < 200; attempt += 1) {
        for (const key of Object.keys(moduleCache)) {
          delete moduleCache[key];
        }

        entryModule = undefined;

        try {
          entryModule = executeModule(resolved);

          return entryModule.exports;
        } catch (error) {
          if (error instanceof MissingModuleError) {
            const key = `module:${error.specifier}|${error.fromDir}`;

            if (attempted.has(key)) {
              throw error;
            }

            attempted.add(key);
            options.onRetry?.(`loading dynamically required module '${error.specifier}'`);
            await collectMissingModule(error.specifier, error.fromDir);
            continue;
          }

          if (error instanceof MissingPathError) {
            const key = `path:${error.path}|${error.operation}`;

            if (attempted.has(key)) {
              throw error;
            }

            attempted.add(key);
            options.onRetry?.(`reading '${error.path}' from the workspace`);

            const hydrated = await runtimeFs.hydrate(error.path, error.operation);

            if (!hydrated) {
              throw new Error(`ENOENT: no such file or directory, '${error.path}'`);
            }

            continue;
          }

          throw error;
        }
      }

      throw new Error("Module loading did not converge.");
    },

    dispose() {
      sourceCache.clear();
      collected.clear();
      collecting.clear();
      resolutions.clear();

      for (const key of Object.keys(moduleCache)) {
        delete moduleCache[key];
      }
    },
  };
}
