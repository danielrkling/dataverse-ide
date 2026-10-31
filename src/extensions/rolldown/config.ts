import * as v from "valibot";

import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";
import {
  ROLLDOWN_FORMATS,
  defineSchema,
  parseConfig,
  stringListSchema,
  withDefault,
  workspacePathListSchema,
  workspacePathSchema,
} from "../shared/configSchema.js";

/*
 * rolldown.config.json - the source of truth for rolldown (oxc wasm)
 * workspace builds, mirroring esbuild.config.json.
 *
 * When the file is absent, these defaults apply:
 *
 *   {
 *     "entryPoints": ["src/index.ts"],
 *     "outdir": "dist",
 *     "format": "esm",
 *     "minify": false,
 *     "sourcemap": false,
 *     "external": [],
 *     "define": {},
 *     "solid": "auto"
 *   }
 *
 * Differences from esbuild.config.json:
 *   - no "bundle" key: rolldown always bundles (use "external" to keep
 *     bare imports out)
 *   - no "target" key: the oxc wasm pipeline emits modern ES (rolldown has
 *     no esbuild-style target option at this output position)
 *   - format also accepts "umd"
 *
 * The legacy "entry" (string) and "outDir" (string) keys are still read and
 * are migrated to "entryPoints" / "outdir" the next time the file is written.
 */

const CONFIG_FILE_NAME = "rolldown.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.rolldown",
  defaultPath: CONFIG_FILE_NAME,
};

const SOLID_MODES = ["auto", "v2", "off"] as const;

/** Valibot schema for rolldown.config.json. */
export const ROLLDOWN_CONFIG_SCHEMA = v.object({
  entryPoints: withDefault(workspacePathListSchema, ["src/index.ts"]),
  outdir: withDefault(workspacePathSchema, "dist"),
  format: withDefault(v.picklist(ROLLDOWN_FORMATS), "esm"),
  minify: withDefault(v.boolean(), false),
  sourcemap: withDefault(v.boolean(), false),
  external: withDefault(stringListSchema, []),
  define: withDefault(defineSchema, {}),
  solid: withDefault(v.picklist(SOLID_MODES), "auto"),
});

export type RolldownConfig = v.InferOutput<typeof ROLLDOWN_CONFIG_SCHEMA>;

export const ROLLDOWN_DEFAULT_CONFIG: RolldownConfig = v.parse(ROLLDOWN_CONFIG_SCHEMA, {});

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.rolldown.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Map the legacy "entry"/"outDir" keys onto their canonical names. */
function normalizeLegacyKeys(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;

  return {
    ...record,
    entryPoints: record.entryPoints ?? record.entry,
    outdir: record.outdir ?? record.outDir,
  };
}

/*
 * Read + validate the config file. Returns the raw text (null when absent
 * or unreadable) alongside the parsed config.
 */
export async function readRolldownConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: RolldownConfig }> {
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...ROLLDOWN_DEFAULT_CONFIG } };
  }

  return {
    text,
    config: parseConfig(text, ROLLDOWN_CONFIG_SCHEMA, ROLLDOWN_DEFAULT_CONFIG, normalizeLegacyKeys),
  };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateRolldownConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<RolldownConfig>,
): Promise<RolldownConfig> {
  const { text, config } = await readRolldownConfig(vscode, rootUri);

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
   * survives untouched. Legacy names are dropped so the file converges on
   * the shared esbuild/rolldown property names.
   */
  const { entry: _entry, outDir: _outDir, ...rest } = document;

  const nextDocument: Record<string, unknown> = {
    ...rest,
    entryPoints: merged.entryPoints,
    outdir: merged.outdir,
    format: merged.format,
    minify: merged.minify,
    sourcemap: merged.sourcemap,
    external: merged.external,
    define: merged.define,
    solid: merged.solid,
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
