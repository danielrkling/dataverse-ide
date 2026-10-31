import * as v from "valibot";

import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";
import {
  parseConfig,
  withDefault,
  workspacePathAllowEmptySchema,
  workspacePathSchema,
} from "../shared/configSchema.js";

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

const CONFIG_FILE_NAME = "template.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.template",
  defaultPath: CONFIG_FILE_NAME,
};

const optionalOutputPathSchema = v.pipe(
  workspacePathAllowEmptySchema,
  v.transform((value) => (value.length > 0 ? value : undefined)),
);

/** Valibot schema for one template entry. */
export const TEMPLATE_ENTRY_SCHEMA = v.pipe(
  v.object({
    /** Workspace-relative template file. */
    input: workspacePathSchema,
    /** Workspace-relative output path; the <outputDir>/<name> default when omitted. */
    output: v.optional(v.fallback(optionalOutputPathSchema, undefined)),
  }),
  v.transform((entry) => (entry.output == null ? { input: entry.input } : entry)),
);

/** Valibot schema for template.config.json. */
export const TEMPLATE_CONFIG_SCHEMA = v.object({
  templates: withDefault(
    v.pipe(
      /*
       * Invalid entries are replaced by an empty marker and then dropped,
       * matching the previous reader: one bad template must not discard the
       * whole list.
       */
      v.array(v.fallback(TEMPLATE_ENTRY_SCHEMA, { input: "" })),
      v.transform((entries) => entries.filter((entry) => entry.input.length > 0)),
    ),
    [],
  ),
});

export type TemplateEntry = v.InferOutput<typeof TEMPLATE_ENTRY_SCHEMA>;
export type TemplateConfig = v.InferOutput<typeof TEMPLATE_CONFIG_SCHEMA>;

export const TEMPLATE_DEFAULT_CONFIG: TemplateConfig = v.parse(TEMPLATE_CONFIG_SCHEMA, {});

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
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...TEMPLATE_DEFAULT_CONFIG, templates: [] } };
  }

  return {
    text,
    config: parseConfig(text, TEMPLATE_CONFIG_SCHEMA, TEMPLATE_DEFAULT_CONFIG),
  };
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
