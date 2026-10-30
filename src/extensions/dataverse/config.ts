import type * as vscodeType from "vscode";

import { configFilePathFor, type ConfigPathOptions } from "../shared/configPath.js";

/*
 * dataverse.config.json - the source of truth for web resource upload
 * settings, mirroring esbuild.config.json / rolldown.config.json /
 * tailwind.config.json. When the file is absent, these defaults apply:
 *
 *   {
 *     "prefix": "",
 *     "solution": "",
 *     "uploadRoot": "",
 *     "files": ["**\/*"],
 *     "exclude": [],
 *     "publishAfterUpload": true,
 *     "apiBaseUrl": ""
 *   }
 *
 * Runtime tuning (watch debounce, which file holds this config) is kept in
 * extension settings under dataverseIde.dataverse.* instead of the project
 * file: watchDebounceMs and configPath.
 */

const DEFAULT_CONFIG_PATH = "dataverse.config.json";

const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.dataverse",
  defaultPath: DEFAULT_CONFIG_PATH,
};

export type DataverseConfig = {
  prefix: string;
  solution?: string;
  uploadRoot: string;
  files: string[];
  exclude: string[];
  publishAfterUpload: boolean;
  apiBaseUrl?: string;
};

export const DATAVERSE_DEFAULT_CONFIG: DataverseConfig = {
  prefix: "",
  solution: undefined,
  uploadRoot: "",
  files: ["**/*"],
  exclude: [],
  publishAfterUpload: true,
  apiBaseUrl: undefined,
};

/*
 * Resolve the config file location against the dataverseIde.dataverse.configPath
 * setting (workspace-relative; default dataverse.config.json).
 */
export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/*
 * Read + validate the config file. Unknown values fall back to the matching
 * default. Returns the raw text (null when absent or unreadable) alongside
 * the parsed config so updateDataverseConfig() can rewrite the file without
 * destroying user keys or formatting.
 */
export async function readDataverseConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: DataverseConfig }> {
  const defaults = { ...DATAVERSE_DEFAULT_CONFIG };

  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: defaults };
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text, config: defaults };
  }

  const config: DataverseConfig = { ...defaults };

  if (typeof parsed.prefix === "string") {
    config.prefix = parsed.prefix.trim().replace(/\/+$/, "");
  }

  if (typeof parsed.uploadRoot === "string") {
    config.uploadRoot = parsed.uploadRoot
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
  }

  if (typeof parsed.solution === "string") {
    const solution = parsed.solution.trim();

    config.solution = solution.length > 0 ? solution : undefined;
  }

  if (Array.isArray(parsed.files)) {
    const files = (parsed.files as unknown[]).filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );

    if (files.length > 0) {
      config.files = files.map((entry) => entry.trim());
    }
  }

  if (Array.isArray(parsed.exclude)) {
    config.exclude = (parsed.exclude as unknown[]).filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }

  if (typeof parsed.publishAfterUpload === "boolean") {
    config.publishAfterUpload = parsed.publishAfterUpload;
  }

  if (typeof parsed.apiBaseUrl === "string") {
    const apiBaseUrl = parsed.apiBaseUrl.trim();

    config.apiBaseUrl = apiBaseUrl.length > 0 ? apiBaseUrl : undefined;
  }

  return { text, config };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateDataverseConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<DataverseConfig>,
): Promise<DataverseConfig> {
  const { text, config } = await readDataverseConfig(vscode, rootUri);

  let document: Record<string, unknown> = {};

  if (text != null) {
    try {
      document = JSON.parse(text) as Record<string, unknown>;
    } catch {
      document = {};
    }
  }

  const merged = { ...config, ...updates };

  /*
   * Only write the managed keys; anything else the user keeps in the file
   * (e.g. comments-as-keys, extra tooling fields) survives untouched.
   * A legacy "watchDebounceMs" key is not rewritten: debounce lives in the
   * dataverseIde.dataverse.watchDebounceMs extension setting.
   */
  const nextDocument: Record<string, unknown> = {
    ...document,
    prefix: merged.prefix,
    solution: merged.solution ?? "",
    uploadRoot: merged.uploadRoot,
    files: merged.files,
    exclude: merged.exclude,
    publishAfterUpload: merged.publishAfterUpload,
    apiBaseUrl: merged.apiBaseUrl ?? "",
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
