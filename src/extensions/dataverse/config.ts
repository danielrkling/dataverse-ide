import * as v from "valibot";

import type * as vscodeType from "vscode";

import { configFilePathFor, type ConfigPathOptions } from "../shared/configPath.js";
import {
  parseConfig,
  stringListSchema,
  withDefault,
  workspaceRootSchema,
} from "../shared/configSchema.js";

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

const CONFIG_FILE_NAME = "dataverse.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.dataverse",
  defaultPath: CONFIG_FILE_NAME,
};

const optionalTrimmedStringSchema = v.optional(
  v.fallback(
    v.pipe(
      v.string(),
      v.transform((value) => {
        const trimmed = value.trim();

        return trimmed.length > 0 ? trimmed : undefined;
      }),
    ),
    undefined,
  ),
);

/** Valibot schema for dataverse.config.json. */
export const DATAVERSE_CONFIG_SCHEMA = v.object({
  prefix: withDefault(
    v.pipe(
      v.string(),
      v.transform((value) => value.trim().replace(/\/+$/, "")),
    ),
    "",
  ),
  solution: optionalTrimmedStringSchema,
  uploadRoot: withDefault(workspaceRootSchema, ""),
  files: withDefault(
    v.pipe(
      stringListSchema,
      v.check((files) => files.length > 0, "Expected at least one file pattern."),
    ),
    ["**/*"],
  ),
  exclude: withDefault(stringListSchema, []),
  publishAfterUpload: withDefault(v.boolean(), true),
  apiBaseUrl: optionalTrimmedStringSchema,
});

export type DataverseConfig = v.InferOutput<typeof DATAVERSE_CONFIG_SCHEMA>;

export const DATAVERSE_DEFAULT_CONFIG: DataverseConfig = v.parse(DATAVERSE_CONFIG_SCHEMA, {});

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
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...DATAVERSE_DEFAULT_CONFIG } };
  }

  return {
    text,
    config: parseConfig(text, DATAVERSE_CONFIG_SCHEMA, DATAVERSE_DEFAULT_CONFIG),
  };
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
