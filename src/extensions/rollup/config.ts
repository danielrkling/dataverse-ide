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
 * rollup.config.json - the source of truth for rollup (@rollup/browser)
 * builds, mirroring esbuild.config.json / rolldown.config.json.
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
 *     "define": {}
 *   }
 *
 * Differences from esbuild.config.json:
 *   - no "bundle" key: rollup always bundles (use "external" to keep
 *     bare imports out)
 *   - no "target" key: TypeScript/JSX lowering is handled by the shared
 *     esbuild-wasm transform before Rollup sees the module
 *   - format also accepts "umd"
 *   - minify runs as a Rollup renderChunk pass (esbuild-wasm minifier), so
 *     sourcemaps chain through Rollup's output pipeline
 *
 * The legacy "entry" (string) and "outDir" (string) keys are still read and
 * are migrated to "entryPoints" / "outdir" the next time the file is written.
 */

const CONFIG_FILE_NAME = "rollup.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.rollup",
  defaultPath: CONFIG_FILE_NAME,
};

/** Valibot schema for rollup.config.json. */
export const ROLLUP_CONFIG_SCHEMA = v.object({
  entryPoints: withDefault(workspacePathListSchema, ["src/index.ts"]),
  outdir: withDefault(workspacePathSchema, "dist"),
  format: withDefault(v.picklist(ROLLDOWN_FORMATS), "esm"),
  minify: withDefault(v.boolean(), false),
  sourcemap: withDefault(v.boolean(), false),
  external: withDefault(stringListSchema, []),
  define: withDefault(defineSchema, {}),
});

export type RollupConfig = v.InferOutput<typeof ROLLUP_CONFIG_SCHEMA>;

export const ROLLUP_DEFAULT_CONFIG: RollupConfig = v.parse(ROLLUP_CONFIG_SCHEMA, {});

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.rollup.configPath). */
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
export async function readRollupConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: RollupConfig }> {
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...ROLLUP_DEFAULT_CONFIG } };
  }

  return {
    text,
    config: parseConfig(text, ROLLUP_CONFIG_SCHEMA, ROLLUP_DEFAULT_CONFIG, normalizeLegacyKeys),
  };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateRollupConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<RollupConfig>,
): Promise<RollupConfig> {
  const { text, config } = await readRollupConfig(vscode, rootUri);

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
   * the shared esbuild/rolldown/rollup property names.
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
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
