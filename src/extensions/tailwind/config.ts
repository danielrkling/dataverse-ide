import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";

/*
 * tailwind.config.json - the source of truth for workspace CSS builds.
 *
 * Same file shape as dataverse-dev-tools (files/input/output). Watch is not
 * stored here — it lives in the workspace/user setting
 * `dataverseIde.tailwind.watch` so the toggle doesn't rewrite project files.
 * When the file is absent, these defaults apply:
 *
 *   {
 *     "input": "src/tailwind.css",   // @import "tailwindcss"; + theme/plugin setup
 *     "output": "dist/tailwind.css",
 *     "minify": false                // minify via the esbuild CSS minifier
 *   }
 */

const CONFIG_FILE_NAME = "tailwind.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.tailwind",
  defaultPath: CONFIG_FILE_NAME,
};

export type TailwindConfig = {
  /** Workspace CSS entry. When unset, `@import "tailwindcss";` is used. */
  input: string;
  /** Workspace-relative output path. */
  output: string;
  /** Minify the compiled CSS through the esbuild worker. */
  minify: boolean;
};

export const TAILWIND_DEFAULT_CONFIG: TailwindConfig = {
  input: "",
  output: "dist/tailwind.css",
  minify: false,
};

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.tailwind.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

export async function readTailwindConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: TailwindConfig }> {
  const config: TailwindConfig = { ...TAILWIND_DEFAULT_CONFIG };

  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config };
  }

  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text, config };
  }

  if (typeof parsed.input === "string" && parsed.input.trim().length > 0) {
    config.input = parsed.input.trim().replaceAll("\\", "/");
  }

  if (typeof parsed.output === "string" && parsed.output.trim().length > 0) {
    config.output = parsed.output.trim().replaceAll("\\", "/");
  }

  if (typeof parsed.minify === "boolean") {
    config.minify = parsed.minify;
  }

  return { text, config };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateTailwindConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<TailwindConfig>,
): Promise<TailwindConfig> {
  const { text, config } = await readTailwindConfig(vscode, rootUri);

  let document: Record<string, unknown> = {};

  if (text != null) {
    try {
      document = JSON.parse(text) as Record<string, unknown>;
    } catch {
      document = {};
    }
  }

  const merged = { ...config, ...updates };

  const nextDocument: Record<string, unknown> = {
    ...document,
    input: merged.input,
    output: merged.output,
    minify: merged.minify,
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
