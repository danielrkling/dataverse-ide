import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";

/*
 * template.config.json - the source of truth for which templates are built
 * (and thereby watched), mirroring esbuild.config.json's configured-entry
 * role. A "templates" entry seeded into watch when Template: Start Watch
 * boots with no session watch pairs.
 *
 *   {
 *     "templates": [
 *       { "input": "index.template.html", "output": "dist/index.html" },
 *       { "input": "README.template.md" }
 *     ]
 *   }
 *
 * "output" is optional: when omitted the default
 * `<dataverseIde.template.outputDir>/<name>` convention applies (the
 * .template marker stripped). The file location is overridable by the
 * dataverseIde.template.configPath extension setting.
 */

const DEFAULT_CONFIG_PATH = "template.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.template",
  defaultPath: DEFAULT_CONFIG_PATH,
};

export type TemplateEntry = {
  /** Workspace-relative template file. */
  input: string;
  /** Workspace-relative output path; the <outputDir>/<name> default when omitted. */
  output?: string;
};

export type TemplateConfig = {
  templates: TemplateEntry[];
};

export const TEMPLATE_DEFAULT_CONFIG: TemplateConfig = {
  templates: [],
};

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.template.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/*
 * Read + validate the config file. Returns the raw text (null when absent
 * or unreadable) alongside the parsed config so updateTemplateConfig() can
 * rewrite the file without destroying user keys or formatting.
 */
export async function readTemplateConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: TemplateConfig }> {
  const defaults = { ...TEMPLATE_DEFAULT_CONFIG, templates: [] };

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

  const templates: TemplateEntry[] = [];

  if (Array.isArray(parsed.templates)) {
    for (const raw of parsed.templates) {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }

      const entry: Record<string, unknown> = raw;

      const input =
        typeof entry.input === "string"
          ? entry.input
              .trim()
              .replaceAll("\\", "/")
              .replace(/^\.\//, "")
              .replace(/^\/+/, "")
              .replace(/\/+$/, "")
          : "";

      if (input.length === 0) {
        continue;
      }

      const outputRaw = typeof entry.output === "string" ? (entry.output as string).trim() : "";

      templates.push(
        outputRaw.length > 0
          ? {
              input,
              output: outputRaw.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, ""),
            }
          : { input },
      );
    }
  }

  return { text, config: { templates } };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateTemplateConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<TemplateConfig>,
): Promise<TemplateConfig> {
  const { text, config } = await readTemplateConfig(vscode, rootUri);

  let document: Record<string, unknown> = {};

  if (text != null) {
    try {
      document = JSON.parse(text) as Record<string, unknown>;
    } catch {
      document = {};
    }
  }

  const merged: TemplateConfig = { ...config, ...updates };

  /*
   * Only write the managed keys; anything else the user keeps in the file
   * survives untouched.
   */
  const nextDocument: Record<string, unknown> = {
    ...document,
    templates: merged.templates.map((entry) =>
      entry.output == null ? { input: entry.input } : { input: entry.input, output: entry.output },
    ),
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
