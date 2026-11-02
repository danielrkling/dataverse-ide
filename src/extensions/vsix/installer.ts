import {
  ExtensionHostKind,
  getBuiltinExtensions,
  registerExtension,
  type RegisterLocalExtensionResult,
} from "@codingame/monaco-vscode-api/extensions";
import { ExtensionType } from "@codingame/monaco-vscode-api/vscode/vs/platform/extensions/common/extensions";

import type { IExtensionManifest } from "@codingame/monaco-vscode-api/extensions";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";

import { extensionId, extensionManifests } from "../registry.js";
import { deleteStoredVsix, listStoredVsix, saveStoredVsix, type StoredVsix } from "./store.js";
import { assertWebCompatible, mimeTypeForPath, readVsix, vsixExtensionId } from "./vsix.js";
import type { ParsedVsix } from "./vsix.js";

/*
 * Registers VSIX extensions with monaco-vscode-api.
 *
 * Installed packages are served with registerFileUrl: every file becomes a
 * data: URL in the extension-file filesystem. The extension host iframe CSP
 * allows `connect-src data:` (but not blob:), and data: URLs also work when
 * the iframe runs on an alternate localhost subdomain during development.
 *
 * Registration must happen before `initialize()` on startup so the extension
 * is part of the built-in extension list scanned by the Extensions view.
 * Installing at runtime works through the extension service delta path; the
 * Extensions view itself picks the extension up after a reload.
 */

export type InstalledVsix = {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  version: string;
  fileName: string;
};

type ActiveVsix = {
  id: string;
  result: RegisterLocalExtensionResult;
  fileUrls: IDisposable[];
};

const activeVsix = new Map<string, ActiveVsix>();

function inHouseExtensionIds(): Set<string> {
  return new Set(Object.values(extensionManifests).map((manifest) => extensionId(manifest)));
}

function describe(manifest: IExtensionManifest, fileName: string): InstalledVsix {
  const displayName =
    manifest.displayName != null && !/^%.*%$/.test(manifest.displayName)
      ? manifest.displayName
      : manifest.name;

  return {
    id: vsixExtensionId(manifest),
    publisher: manifest.publisher,
    name: manifest.name,
    displayName,
    version: manifest.version,
    fileName,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function toDataUrl(content: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(content)}`;
}

function readmePathFor(files: Map<string, Uint8Array>): string | undefined {
  for (const name of ["readme.md", "readme.markdown", "readme.txt"]) {
    const match = [...files.keys()].find((path) => path.toLowerCase() === name);

    if (match != null) {
      return match;
    }
  }

  return undefined;
}

function changelogPathFor(files: Map<string, Uint8Array>): string | undefined {
  for (const name of ["changelog.md", "changelog.markdown", "changelog.txt"]) {
    const match = [...files.keys()].find((path) => path.toLowerCase() === name);

    if (match != null) {
      return match;
    }
  }

  return undefined;
}

/** Mark restored extensions as user extensions so they appear in Installed. */
function markAsUserExtension(id: string): void {
  const entry = getBuiltinExtensions().find(
    (extension) => extension.identifier.id.toLowerCase() === id,
  );

  if (entry == null) {
    return;
  }

  const mutable = entry as unknown as {
    isBuiltin: boolean;
    type: ExtensionType;
  };

  mutable.isBuiltin = false;
  mutable.type = ExtensionType.User;
}

function assertCanInstall(id: string): void {
  if (inHouseExtensionIds().has(id)) {
    throw new Error(`"${id}" is built into Dataverse IDE and cannot be replaced by a VSIX.`);
  }

  if (activeVsix.has(id)) {
    // Reinstall/upgrade: the existing registration is disposed by register().
    return;
  }

  const existing = getBuiltinExtensions().find(
    (extension) => extension.identifier.id.toLowerCase() === id,
  );

  if (existing != null) {
    throw new Error(`An extension with the id "${id}" is already part of the IDE.`);
  }
}

async function disposeActive(active: ActiveVsix): Promise<void> {
  for (const disposable of active.fileUrls) {
    disposable.dispose();
  }

  try {
    await active.result.dispose();
  } catch (error) {
    console.warn(`[Dataverse IDE] Failed to dispose extension "${active.id}".`, error);
  }
}

async function register(parsed: ParsedVsix, awaitReady: boolean): Promise<void> {
  const id = vsixExtensionId(parsed.manifest);
  const existing = activeVsix.get(id);

  if (existing != null) {
    await disposeActive(existing);
    activeVsix.delete(id);
  }

  const result = registerExtension(parsed.manifest, ExtensionHostKind.LocalWebWorker, {
    readmePath: readmePathFor(parsed.files),
    changelogPath: changelogPathFor(parsed.files),
  });

  const fileUrls: IDisposable[] = [];

  for (const [path, content] of parsed.files) {
    const mimeType = mimeTypeForPath(path);

    fileUrls.push(
      result.registerFileUrl(path, toDataUrl(content, mimeType), {
        mimeType,
        size: content.byteLength,
      }),
    );
  }

  activeVsix.set(id, { id, result, fileUrls });
  markAsUserExtension(id);

  if (awaitReady) {
    await result.whenReady();
  }

  console.info(`[Dataverse IDE] Registered VSIX extension "${id}".`);
}

/**
 * Restore packages persisted in IndexedDB. Call once, before `initialize()`,
 * so the extensions are present in the workbench's built-in scan.
 *
 * A broken package is reported and skipped; it stays persisted so the user
 * can see/uninstall it from the VSIX commands.
 */
export async function restoreInstalledVsixExtensions(): Promise<void> {
  let stored: StoredVsix[];

  try {
    stored = await listStoredVsix();
  } catch (error) {
    console.warn("[Dataverse IDE] Could not read installed VSIX packages.", error);
    return;
  }

  for (const entry of stored) {
    try {
      const parsed = await readVsix(entry.data);
      assertWebCompatible(parsed);

      const id = vsixExtensionId(parsed.manifest);

      if (id !== entry.id) {
        throw new Error(`Stored package id "${entry.id}" does not match its manifest id "${id}".`);
      }

      assertCanInstall(id);
      await register(parsed, false);
    } catch (error) {
      console.warn(`[Dataverse IDE] Could not restore VSIX "${entry.fileName}".`, error);
    }
  }
}

/**
 * Install a VSIX from raw archive bytes and persist it for future sessions.
 */
export async function installVsixFromBytes(
  data: Uint8Array,
  fileName: string,
): Promise<InstalledVsix> {
  const parsed = await readVsix(data);
  assertWebCompatible(parsed);

  const info = describe(parsed.manifest, fileName);
  assertCanInstall(info.id);

  const previous = (await listStoredVsix()).find((entry) => entry.id === info.id);
  const stored: StoredVsix = {
    ...info,
    installedAt: Date.now(),
    data,
  };

  await saveStoredVsix(stored);

  try {
    await register(parsed, true);
  } catch (error) {
    /*
     * Keep the previously installed version restorable if this was an
     * upgrade that failed to register.
     */
    if (previous != null) {
      await saveStoredVsix(previous);
    } else {
      await deleteStoredVsix(info.id);
    }

    throw error;
  }

  return info;
}

export async function listInstalledVsix(): Promise<InstalledVsix[]> {
  const stored = await listStoredVsix();

  return stored
    .map(({ data: _data, installedAt: _installedAt, ...info }) => info)
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * Remove a package from IndexedDB and from the running extension registry.
 * Returns false when no package with that id existed.
 */
export async function uninstallVsix(id: string): Promise<boolean> {
  const normalized = id.toLowerCase();
  const stored = await listStoredVsix();
  const exists = stored.some((entry) => entry.id.toLowerCase() === normalized);

  if (!exists) {
    return false;
  }

  const active = activeVsix.get(normalized);

  if (active != null) {
    await disposeActive(active);
    activeVsix.delete(normalized);
  }

  await deleteStoredVsix(normalized);

  return true;
}

/** Exposed for diagnostics/tests: installed extension ids in this session. */
export function activeVsixIds(): string[] {
  return [...activeVsix.keys()];
}
