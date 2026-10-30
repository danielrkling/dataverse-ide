/*
 * Shared virtual-filesystem package resolver.
 *
 * Extracted from the esbuild worker (src/extensions/esbuild/worker.ts) so
 * the rolldown worker can resolve bare imports against the same in-memory
 * file map with the same lazy-resolution ("needFiles") semantics, keeping
 * the two bundling pipelines consistent.
 *
 * Works purely on a Record<string, string> of workspace-relative,
 * slash-normalized, './'-free paths (as produced by the main thread's
 * collectWorkspaceSources). No node APIs, no absolute paths.
 */

export const RESOLVABLE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
];

export const INDEX_TRAILS = [
  "/index.ts",
  "/index.tsx",
  "/index.mts",
  "/index.cts",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
  "/index.css",
  "/index.json",
];

/*
 * Package resolution order. ESM files come before CommonJS files because
 * browser bundles should prefer package ESM builds when available.
 */
export const COMPANION_EXTENSIONS = [
  "",
  ".mjs",
  ".js",
  ".jsx",
  ".cjs",
  ".ts",
  ".tsx",
  ".css",
  ".json",
];

/*
 * Node builtins have no browser implementation in these extensions. Leave
 * them external so a user can provide a browser-compatible shim, or so the
 * final output visibly identifies that it cannot run standalone in-browser.
 */
export const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/*
 * Conditions this browser resolver activates when walking a package's
 * conditional exports/imports map. "browser" is listed first for
 * documentation only: precedence inside a single map always comes from the
 * package's own key order, not from this set.
 */
export const EXPORT_CONDITIONS = new Set(["browser", "import", "module", "default", "require"]);

/*
 * Resolve a conditional exports/imports target into a concrete path string.
 *
 * Follows the Node.js PACKAGE_EXPORTS_RESOLVE algorithm: iterate the object's
 * own key order and take the first key that is an active condition, recursing
 * when that branch is itself an object. Key order wins over the condition list
 * order, which is what Node, esbuild, and Vite all do - iterating our
 * condition list first would pick a different file than Node does whenever a
 * package lists two active conditions in an order we don't happen to agree
 * with.
 */
function resolveConditionalExport(target: unknown, conditions: Set<string>): string | undefined {
  if (typeof target === "string") {
    return target;
  }

  if (Array.isArray(target)) {
    for (const entry of target) {
      const resolved = resolveConditionalExport(entry, conditions);

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

    const resolved = resolveConditionalExport((target as Record<string, unknown>)[key], conditions);

    if (resolved != null) {
      return resolved;
    }
  }

  return undefined;
}

/*
 * A path "has a file extension" when its last segment contains a dot and is
 * followed by a known extension. Extension-less paths (package roots,
 * "fp", index candidates) must be probed against every extension; existing
 * extensioned paths must not be probed further (probing "index.mjs.cjs" is
 * always pointless).
 */
const KNOWN_EXTENSIONS = new Set([
  ...RESOLVABLE_EXTENSIONS,
  ...COMPANION_EXTENSIONS,
  ...INDEX_TRAILS,
]);

export function hasFileExtension(path: string): boolean {
  const basename = path.split("/").pop() ?? "";
  const dotIndex = basename.lastIndexOf(".");

  if (dotIndex <= 0) {
    return false;
  }

  return KNOWN_EXTENSIONS.has(basename.slice(dotIndex));
}

export function normalizePath(value: string): string {
  const segments: string[] = [];

  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

export function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;

    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/*
 * Split a bare import into its node_modules package directory and any
 * package subpath.
 *
 * Examples:
 *
 *   lodash                 -> node_modules/lodash, ""
 *   lodash/fp              -> node_modules/lodash, "fp"
 *   @scope/pkg             -> node_modules/@scope/pkg, ""
 *   @scope/pkg/subpath     -> node_modules/@scope/pkg, "subpath"
 */
export function splitPackageSpec(specifier: string): {
  packageDir: string;
  subpath: string;
} {
  let packageName: string;
  let subpath: string;

  if (specifier.startsWith("@")) {
    const firstSlash = specifier.indexOf("/");
    const secondSlash = specifier.indexOf("/", firstSlash + 1);

    if (firstSlash === -1 || secondSlash === -1) {
      packageName = specifier;
      subpath = "";
    } else {
      packageName = specifier.slice(0, secondSlash);
      subpath = specifier.slice(secondSlash + 1);
    }
  } else {
    const firstSlash = specifier.indexOf("/");

    if (firstSlash === -1) {
      packageName = specifier;
      subpath = "";
    } else {
      packageName = specifier.slice(0, firstSlash);
      subpath = specifier.slice(firstSlash + 1);
    }
  }

  return {
    packageDir: `node_modules/${packageName}`,
    subpath,
  };
}

/*
 * Resolve a package target such as:
 *
 *   "./dist/index.js"
 *
 * against:
 *
 *   "node_modules/example-package"
 *
 * The normalizePath() call is essential. Without it, targets containing "./"
 * become paths such as:
 *
 *   node_modules/example-package/./dist/index.js
 *
 * which do not match the normalized paths used as keys in the file map.
 */
function resolveExportTarget(
  target: string,
  lookup: (path: string) => string | undefined,
): string | undefined {
  const normalized = normalizePath(target.replaceAll("\\", "/").replace(/\/+$/, ""));

  if (normalized.length === 0) {
    return undefined;
  }

  return lookup(normalized);
}

/*
 * Resolve package.json "exports".
 *
 * Supports common modern package structures:
 *
 * Root string:
 *   "exports": "./dist/index.js"
 *
 * Conditional root export:
 *   "exports": {
 *     ".": {
 *       "browser": "./dist/browser.js",
 *       "import": "./dist/index.mjs",
 *       "default": "./dist/index.js"
 *     }
 *   }
 *
 * Subpath export:
 *   "exports": {
 *     "./plugin": "./dist/plugin.js"
 *   }
 *
 * Wildcard subpath export:
 *   "exports": {
 *     "./features/*": "./dist/features/*.js"
 *   }
 */
function resolveExportsField(
  exportsField: unknown,
  subpath: string,
  pkgDir: string,
  lookup: (path: string) => string | undefined,
): string | undefined {
  if (exportsField == null) {
    return undefined;
  }

  if (typeof exportsField === "string") {
    /*
     * A direct string exports only the package root. It does not expose
     * arbitrary package subpaths.
     */
    if (subpath.length > 0) {
      return undefined;
    }

    return resolveExportTarget(`${pkgDir}/${exportsField}`, lookup);
  }

  if (Array.isArray(exportsField)) {
    for (const candidate of exportsField) {
      const resolved = resolveExportsField(candidate, subpath, pkgDir, lookup);

      if (resolved != null) {
        return resolved;
      }
    }

    return undefined;
  }

  if (typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return undefined;
  }

  const map = exportsField as Record<string, unknown>;

  const requestedSubpath = subpath.length === 0 ? "." : `./${subpath.replace(/^\.\//, "")}`;

  /*
   * A map with "." or "./…" keys is a package subpath map. A map without
   * those keys is normally a conditional export map.
   */
  const hasSubpathEntries = Object.keys(map).some((key) => key === "." || key.startsWith("./"));

  if (hasSubpathEntries) {
    const directTarget = map[requestedSubpath];

    if (directTarget != null) {
      return resolveExportsField(directTarget, "", pkgDir, lookup);
    }

    /*
     * Basic wildcard support:
     *
     *   "./locale/*": "./dist/locale/*.js"
     */
    for (const [pattern, target] of Object.entries(map)) {
      if (!pattern.includes("*")) {
        continue;
      }

      const wildcardIndex = pattern.indexOf("*");
      const prefix = pattern.slice(0, wildcardIndex);
      const suffix = pattern.slice(wildcardIndex + 1);

      if (!requestedSubpath.startsWith(prefix) || !requestedSubpath.endsWith(suffix)) {
        continue;
      }

      const wildcardValue = requestedSubpath.slice(
        prefix.length,
        requestedSubpath.length - suffix.length,
      );

      if (typeof target === "string") {
        return resolveExportTarget(`${pkgDir}/${target.replaceAll("*", wildcardValue)}`, lookup);
      }

      /*
       * Conditional wildcard targets are uncommon but valid. Resolve the
       * conditional object the same way as elsewhere: package key order
       * defines precedence, then substitute the wildcard into the winning
       * template.
       */
      if (typeof target === "object" && target != null && !Array.isArray(target)) {
        const conditionTarget = resolveConditionalExport(target, EXPORT_CONDITIONS);

        if (conditionTarget != null) {
          return resolveExportTarget(
            `${pkgDir}/${conditionTarget.replaceAll("*", wildcardValue)}`,
            lookup,
          );
        }
      }
    }

    return undefined;
  }

  /*
   * Conditional export map.
   *
   * Follows the Node.js PACKAGE_EXPORTS_RESOLVE algorithm: iterate the
   * object's own key order and take the first key that is an active
   * condition, recursing when that branch is itself an object. Key order
   * wins over the condition list order, which is what Node, esbuild, and
   * Vite all do - iterating a fixed condition list first would pick a
   * different file than Node does whenever a package lists two active
   * conditions in an order we don't happen to agree with.
   */
  for (const key of Object.keys(map)) {
    if (!EXPORT_CONDITIONS.has(key)) {
      continue;
    }

    const target = map[key];

    /*
     * A matched string target is authoritative. The package said "under
     * this condition, this exact file is the entry point". If we then fail
     * to find it in the virtual filesystem and quietly fall through to a
     * later branch, we resolve a completely different build than the
     * package intended - typically the server bundle of a library that
     * also ships a browser one, which then fails to resolve server-only
     * dependencies several modules later. So a condition match that misses
     * the filesystem is reported as unresolved instead of being downgraded.
     */
    if (typeof target === "string") {
      return resolveExportTarget(`${pkgDir}/${target}`, lookup);
    }

    const resolved = resolveExportsField(target, "", pkgDir, lookup);

    if (resolved != null) {
      return resolved;
    }
  }

  return undefined;
}

export type PackageResolver = {
  resolveBareImport: (specifier: string) => string | undefined;
  resolvePackageImport: (specifier: string, importer: string) => string | undefined;
};

/*
 * Create the resolver over a file map. reportMissing is called with every
 * concrete path the resolver needed but could not find (used for lazy
 * "needFiles" probe rounds by the bundling workers).
 */
export function createPackageResolver(
  files: Record<string, string>,
  reportMissing: (path: string) => void,
): PackageResolver {
  function lookup(path: string): string | undefined {
    const normalized = normalizePath(path);

    if (files[normalized] != null) {
      return normalized;
    }

    /*
     * Lazy resolution: report the exact requested path, then extension
     * candidates. For an extensioned request (e.g. an exports target such
     * as "./dist/index.mjs") probing further extensions is pointless;
     * only index trails apply to extension-less requests.
     */
    if (hasFileExtension(normalized)) {
      reportMissing(normalized);
      return undefined;
    }

    for (const extension of COMPANION_EXTENSIONS) {
      const candidate = `${normalized}${extension}`;

      if (files[candidate] != null) {
        return candidate;
      }

      reportMissing(candidate);
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`;

      if (files[candidate] != null) {
        return candidate;
      }

      reportMissing(candidate);
    }

    return undefined;
  }

  function resolveBareImport(specifier: string): string | undefined {
    const { packageDir, subpath } = splitPackageSpec(specifier);

    const packageJsonText = files[`${packageDir}/package.json`];

    if (packageJsonText == null) {
      /*
       * Lazy resolution: without the manifest nothing can be resolved; ask
       * the main thread for it (next round re-resolves the full package).
       */
      reportMissing(`${packageDir}/package.json`);
    }

    const packageJson = packageJsonText != null ? parseJsonSafe(packageJsonText) : undefined;

    if (packageJson != null) {
      /*
       * "exports" is authoritative when present. Do not attempt arbitrary
       * internal paths after an exports map rejects a requested subpath.
       */
      if (packageJson.exports != null) {
        const viaExports = resolveExportsField(packageJson.exports, subpath, packageDir, lookup);

        if (viaExports != null) {
          return viaExports;
        }

        return undefined;
      }

      /*
       * For a package subpath without exports, try the requested file path.
       *
       * Example:
       *   import "lodash/fp"
       *   -> node_modules/lodash/fp.js
       *   -> node_modules/lodash/fp/index.js
       */
      if (subpath.length > 0) {
        return lookup(`${packageDir}/${subpath}`);
      }

      /*
       * Browser bundling should favor browser/module entry points before
       * CommonJS main when the package has no exports map.
       */
      for (const entryField of ["browser", "module", "main"]) {
        const entry = packageJson[entryField];

        if (typeof entry !== "string" || entry.length === 0) {
          continue;
        }

        const resolved = resolveExportTarget(`${packageDir}/${entry}`, lookup);

        if (resolved != null) {
          return resolved;
        }
      }
    }

    /*
     * Fallback for packages with no readable package.json.
     */
    return subpath.length > 0 ? lookup(`${packageDir}/${subpath}`) : lookup(packageDir);
  }

  /*
   * Find the nearest package root (directory holding a package.json) for an
   * importer file inside the virtual filesystem, walking up parent
   * directories. Package "imports" specifiers are resolved against the
   * importer's nearest package.json, exactly like Node does.
   */
  function findPackageRoot(importer: string): string | undefined {
    const segments = normalizePath(importer)
      .split("/")
      .filter((segment) => segment.length > 0);

    /*
     * The importer is a file path; drop the file name so the walk starts at
     * the containing directory.
     */
    if (segments.length > 0) {
      segments.pop();
    }

    for (let index = segments.length; index >= 0; index--) {
      const directory = segments.slice(0, index).join("/");

      const packageJsonPath = directory.length === 0 ? "package.json" : `${directory}/package.json`;

      if (files[packageJsonPath] != null) {
        return directory.length === 0 ? "" : directory;
      }
    }

    return undefined;
  }

  /*
   * Resolve a package "imports" specifier such as "#example" or
   * "#example/detail" against the importer's nearest package.json.
   *
   * Supports direct keys, wildcard keys ("#features/*"), conditional maps,
   * and nested references (#-targeting #-targets, depth-limited). Paths
   * must be relative ("./…") and are resolved against the package root.
   */
  function resolvePackageImport(
    specifier: string,
    importer: string,
    depth = 0,
  ): string | undefined {
    if (depth > 3) {
      return undefined;
    }

    const packageDir = findPackageRoot(importer);

    if (packageDir == null) {
      return undefined;
    }

    const packageJson = parseJsonSafe(files[`${packageDir}/package.json`] ?? "");

    const importsField = packageJson?.imports;

    if (importsField == null || typeof importsField !== "object" || Array.isArray(importsField)) {
      return undefined;
    }

    const map = importsField as Record<string, unknown>;
    const requested = specifier.slice(1);

    let target = map[specifier];
    let wildcardValue: string | undefined;

    /*
     * Basic wildcard support:
     *
     *   "#features/*": "./src/features/*.js"
     */
    if (target == null) {
      for (const [pattern, value] of Object.entries(map)) {
        if (!pattern.includes("*")) {
          continue;
        }

        const wildcardIndex = pattern.indexOf("*");
        const prefix = pattern.slice(0, wildcardIndex);
        const suffix = pattern.slice(wildcardIndex + 1);

        if (
          !specifier.startsWith(prefix) ||
          !specifier.endsWith(suffix) ||
          specifier.length < prefix.length + suffix.length
        ) {
          continue;
        }

        wildcardValue = specifier.slice(prefix.length, specifier.length - suffix.length);

        target = value;
        break;
      }
    }

    if (target == null) {
      return undefined;
    }

    const template = resolveConditionalExport(target, EXPORT_CONDITIONS);

    if (template == null) {
      return undefined;
    }

    const substituted = wildcardValue == null ? template : template.replaceAll("*", wildcardValue);

    /*
     * An imports target may itself be another "#…" specifier; resolve it
     * recursively against the same package.json.
     */
    if (substituted.startsWith("#")) {
      return resolvePackageImport(substituted, importer, depth + 1);
    }

    if (!substituted.startsWith("./")) {
      return undefined;
    }

    return resolveExportTarget(`${packageDir}/${substituted}`, lookup);
  }

  return {
    resolveBareImport,
    resolvePackageImport,
  };
}
