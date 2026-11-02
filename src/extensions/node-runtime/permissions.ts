/*
 * Permission model for the direct-fs Node runtime.
 *
 * Filesystem restrictions are enforced by both the workspace reader and the
 * fs shim (sync + async mutations). Network blocking is best-effort: user
 * code shares the extension-host worker globals, so a dedicated worker would
 * be required for a real security boundary.
 */

import type * as vscodeType from "vscode";

export const NODE_PERMISSION_LEVELS = ["read-only", "workspace", "trusted"] as const;

export type NodePermissionLevel = (typeof NODE_PERMISSION_LEVELS)[number];

export type NodePermissions = {
  filesystem: "read-only" | "read-write";
  network: "blocked" | "allowed";
};

export const DEFAULT_NODE_PERMISSION_LEVEL: NodePermissionLevel = "trusted";

const CONFIG_SECTION = "dataverseIde.nodeRuntime";
const PERMISSIONS_KEY = "permissions";

export function isNodePermissionLevel(value: unknown): value is NodePermissionLevel {
  return typeof value === "string" && (NODE_PERMISSION_LEVELS as readonly string[]).includes(value);
}

export function permissionsForLevel(level: NodePermissionLevel): NodePermissions {
  switch (level) {
    case "read-only":
      return { filesystem: "read-only", network: "blocked" };
    case "workspace":
      return { filesystem: "read-write", network: "blocked" };
    case "trusted":
      return { filesystem: "read-write", network: "allowed" };
  }
}

export function describePermissions(permissions: NodePermissions): string {
  const filesystem =
    permissions.filesystem === "read-only" ? "workspace read-only" : "workspace read/write";
  const network = permissions.network === "allowed" ? "network allowed" : "network blocked";

  return `${filesystem}, ${network}`;
}

export function getDefaultNodePermissionLevel(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): NodePermissionLevel {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<string>(PERMISSIONS_KEY, DEFAULT_NODE_PERMISSION_LEVEL);

  return isNodePermissionLevel(value) ? value : DEFAULT_NODE_PERMISSION_LEVEL;
}
