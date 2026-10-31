/*
 * Main-thread workspace reader + async package resolver for rollup.
 *
 * Rollup's browser build has no filesystem, so the extension supplies a
 * virtual-filesystem plugin that reads only the files the dependency graph
 * actually reaches. This is the same direct-read design as the esbuild
 * extension: no workspace-wide collection, no node_modules manifest scan and
 * no lazy needFiles rounds.
 */

import type * as vscodeType from "vscode";

import {
  COMPANION_EXTENSIONS,
  EXPORT_CONDITIONS,
  INDEX_TRAILS,
  hasFileExtension,
  normalizePath,
  parseJsonSafe,
  splitPackageSpec,
} from "../shared/packageResolver.js";

export type WorkspaceReader = {
  /**
   * Reads a workspace-relative UTF-8 text file. Returns undefined when the
   * file does not exist or cannot be read.
   */
  readText: (path: string) => Promise<string | undefined>;
};

type PackageJson = Record<string, unknown>;

export type PackageResolver = {
  resolveBareImport: (specifier: string) => Promise<string | undefined>;
  resolvePackageImport: (specifier: string, importer: string) => Promise<string | undefined>;
};

/*
 * Creates a cached workspace reader over vscode.workspace.fs.
 *
 * This uses the mounted workspace provider (local folders, browser
 * workspaces and the OPFS node_modules overlay), not raw browser APIs.
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

export function isConfiguredExternal(path: string, externalPaths: string[]): boolean {
  return externalPaths.some((external) => path === external || path.startsWith(`${external}/`));
}

export function joinFromImporter(importer: string, specifier: string): string {
  if (specifier.startsWith("/")) {
    return normalizePath(specifier);
  }

  const importerDirectory = normalizePath(importer)
    .split("/")
    .filter((segment) => segment.length > 0);

  importerDirectory.pop();

  return normalizePath(
    importerDirectory.length > 0 ? `${importerDirectory.join("/")}/${specifier}` : specifier,
  );
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

/** Direct-read package resolver: package.json exports/imports + browser entry fields. */
export function createPackageResolver(reader: WorkspaceReader): PackageResolver {
  const packageJsonCache = new Map<string, Promise<PackageJson | undefined>>();

  async function readPackageJson(packageDirectory: string): Promise<PackageJson | undefined> {
    const packageJsonPath = `${packageDirectory}/package.json`;

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

    const manifestText = await reader.readText(`${packageDir}/package.json`);
    const packageJson = manifestText != null ? parseJsonSafe(manifestText) : undefined;

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

        /*
         * Unlike "exports" targets, entry fields commonly omit the "./"
         * prefix ("main": "dist/index.js").
         */
        const resolved = await lookup(`${packageDir}/${target.replace(/^\.\//, "")}`);

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

export async function resolveRelativeWorkspacePath(
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
