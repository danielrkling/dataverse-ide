/*
 * Workspace identity carried in the URL hash.
 *
 * Local folder handles cannot be serialized into a hash - they resolve
 * through the recents store (idb), so the hash carries the recents record
 * id. OPFS workspaces resolve by directory name.
 *
 * Format:  #/workspace/opfs/<name>      | #/workspace/local/<record-id>
 */

const HASH_PREFIX = "#/workspace/";

export type WorkspaceHashTarget = { kind: "opfs"; name: string } | { kind: "local"; id: string };
function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);

    if (decoded.length === 0 || decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

export function parseWorkspaceHash(
  hash: string = window.location.hash,
): WorkspaceHashTarget | null {
  if (!hash.startsWith(HASH_PREFIX)) {
    return null;
  }

  const rest = hash.slice(HASH_PREFIX.length);
  const slashIndex = rest.indexOf("/");

  if (slashIndex <= 0) {
    return null;
  }

  const kind = rest.slice(0, slashIndex);
  const value = decodeSegment(rest.slice(slashIndex + 1));

  if (value == null) {
    return null;
  }

  if (kind === "opfs") {
    return { kind: "opfs", name: value };
  }

  return { kind: "local", id: value };
}

export function opfsWorkspaceHash(name: string): string {
  return `${HASH_PREFIX}opfs/${encodeURIComponent(name)}`;
}

export function localWorkspaceHash(recordId: string): string {
  return `${HASH_PREFIX}local/${encodeURIComponent(recordId)}`;
}

/**
 * Reflect the workspace in the URL without adding a history entry, so a
 * plain reload reopens the same workspace.
 */
export function setWorkspaceHash(hash: string | null): void {
  const url = new URL(window.location.href);

  if (hash == null) {
    url.hash = "";
  } else {
    url.hash = `#${hash.replace(/^#/, "")}`;
  }

  window.history.replaceState(null, "", url.toString());
}

/**
 * Reflect the active workspace in the URL (kept in view; a reload reopens).
 */
export function setWorkspaceTarget(target: WorkspaceHashTarget): void {
  setWorkspaceHash(
    target.kind === "opfs" ? opfsWorkspaceHash(target.name) : localWorkspaceHash(target.id),
  );
}
