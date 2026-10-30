import type * as vscodeType from "vscode";

/*
 * Shared config-file path resolution for file-driven extensions
 * (esbuild.config.json, rolldown.config.json, tailwind.config.json).
 *
 * Each config file lives at the workspace root by default, but its location
 * is overridable by a workspace-relative extension setting
 * (dataverseIde.<tool>.configPath) so projects can keep their config files
 * in a subdirectory. Path-traversal values are ignored so a broken setting
 * cannot escape the workspace.
 */

export type ConfigPathOptions = {
  /** Extension settings section, e.g. "dataverseIde.esbuild". */
  section: string;
  /** Default workspace-relative file name, e.g. "esbuild.config.json". */
  defaultPath: string;
};

/** Normalized workspace-relative config path (may include subdirectories). */
export function configRelativePath(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: ConfigPathOptions,
): string {
  const configPath = vscode.workspace
    .getConfiguration(options.section, rootUri)
    .get<string>("configPath", options.defaultPath)
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (
    configPath.length === 0 ||
    configPath === ".." ||
    configPath.startsWith("../") ||
    configPath.includes("/../")
  ) {
    return options.defaultPath;
  }

  return configPath;
}

/** Absolute workspace URI of the config file. */
export function configFilePathFor(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: ConfigPathOptions,
): vscodeType.Uri {
  return vscode.Uri.joinPath(rootUri, ...configRelativePath(vscode, rootUri, options).split("/"));
}
