/*
 * Translate a shell path into a workspace URI.
 *
 * Commands receive shell paths relative to `ctx.cwd`, while the IDE command
 * APIs expect `vscode.Uri` values rooted at the workspace. keep the mapping in
 * one place so every command resolves paths identically.
 */

import type * as vscodeType from "vscode";

import type { CommandContext } from "just-bash";

export function workspaceUriForShellPath(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  ctx: CommandContext,
  target: string,
): vscodeType.Uri {
  const absolute = ctx.fs.resolvePath(ctx.cwd, target);
  const relative = absolute.replace(/^\/+/, "");
  const segments = relative.split("/").filter((segment) => segment.length > 0);

  return vscode.Uri.joinPath(rootUri, ...segments);
}
