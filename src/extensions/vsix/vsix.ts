import type { IExtensionManifest } from "@codingame/monaco-vscode-api/extensions";

import { normalizeZipPath, unzip } from "./zip.js";

/*
 * VSIX parsing.
 *
 * The package manifest is `extension/package.json` in a standard VSIX (the
 * generated `extension.vsixmanifest`, `[Content_Types].xml` and `_rels/`
 * metadata are ignored). Hand-built packages that put the extension at the
 * archive root are accepted too.
 */

export type ParsedVsix = {
  manifest: IExtensionManifest;
  /** Extension-relative paths, e.g. "package.json" and "dist/extension.js". */
  files: Map<string, Uint8Array>;
};

const EXTENSION_PREFIX = "extension/";

const ROOT_METADATA_PREFIXES = ["_rels/"];

function isRootMetadata(path: string): boolean {
  if (path === "[Content_Types].xml" || path === "extension.vsixmanifest") {
    return true;
  }

  return ROOT_METADATA_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function findManifestPath(files: Map<string, Uint8Array>): string | undefined {
  if (files.has(`${EXTENSION_PREFIX}package.json`)) {
    return `${EXTENSION_PREFIX}package.json`;
  }

  if (files.has("package.json")) {
    return "package.json";
  }

  return undefined;
}

function parseManifest(bytes: Uint8Array, path: string): IExtensionManifest {
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (error) {
    throw new Error(`Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${path}: expected a JSON object.`);
  }

  const manifest = parsed as Partial<IExtensionManifest>;

  if (typeof manifest.publisher !== "string" || manifest.publisher.length === 0) {
    throw new Error(`Invalid ${path}: missing "publisher".`);
  }

  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`Invalid ${path}: missing "name".`);
  }

  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`Invalid ${path}: missing "version".`);
  }

  if (manifest.displayName != null && typeof manifest.displayName !== "string") {
    throw new Error(`Invalid ${path}: "displayName" must be a string.`);
  }

  if (manifest.engines == null || typeof manifest.engines.vscode !== "string") {
    throw new Error(`Invalid ${path}: missing "engines.vscode".`);
  }

  return manifest as IExtensionManifest;
}

export function vsixExtensionId(manifest: IExtensionManifest): string {
  return `${manifest.publisher}.${manifest.name}`.toLowerCase();
}

/**
 * Parse a VSIX into its manifest and extension-relative files.
 *
 * Throws for corrupt archives, missing manifests, and unsafe paths. Web
 * compatibility is checked separately (see assertWebCompatible).
 */
export async function readVsix(data: Uint8Array): Promise<ParsedVsix> {
  const entries = await unzip(data);
  const allFiles = new Map<string, Uint8Array>();

  for (const entry of entries) {
    if (entry.directory || entry.content == null) {
      continue;
    }

    const path = normalizeZipPath(entry.path);

    if (path.length === 0) {
      continue;
    }

    allFiles.set(path, entry.content);
  }

  const manifestPath = findManifestPath(allFiles);

  if (manifestPath == null) {
    throw new Error("Not a VSIX package: extension/package.json is missing.");
  }

  const manifest = parseManifest(allFiles.get(manifestPath)!, manifestPath);
  const prefix = manifestPath === `${EXTENSION_PREFIX}package.json` ? EXTENSION_PREFIX : "";
  const files = new Map<string, Uint8Array>();

  for (const [path, content] of allFiles) {
    if (prefix.length > 0) {
      if (!path.startsWith(prefix)) {
        // VSIX metadata and signatures live outside extension/.
        continue;
      }

      files.set(path.slice(prefix.length), content);
    } else {
      if (isRootMetadata(path)) {
        continue;
      }

      files.set(path, content);
    }
  }

  return { manifest, files };
}

function entryPointPath(entryPoint: string): string {
  return normalizeZipPath(entryPoint.replace(/^\.\//, ""));
}

/**
 * Reject VSIX packages that cannot run in the web extension host.
 *
 * Declarative extensions (themes, grammars) have neither entry point and are
 * fine. Node-only packages have "main" but no "browser", and the web
 * extension host never loads them.
 */
export function assertWebCompatible(parsed: ParsedVsix): void {
  const { manifest, files } = parsed;

  if (typeof manifest.browser === "string" && manifest.browser.length > 0) {
    const browserPath = entryPointPath(manifest.browser);

    if (!files.has(browserPath)) {
      throw new Error(
        `Invalid web extension: the "browser" entry point "${manifest.browser}" is missing.`,
      );
    }

    return;
  }

  if (typeof manifest.main === "string" && manifest.main.length > 0) {
    throw new Error(
      'This VSIX is not a web extension: it only has a Node.js "main" entry point and no "browser" entry point.',
    );
  }
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function mimeTypeForPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
  const dot = name.lastIndexOf(".");

  if (dot === -1) {
    return "application/octet-stream";
  }

  return MIME_TYPES[name.slice(dot)] ?? "application/octet-stream";
}
