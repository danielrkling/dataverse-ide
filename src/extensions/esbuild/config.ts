import * as v from "valibot";

import type * as vscodeType from "vscode";

/*
 * esbuild.config.json - the source of truth for workspace builds.
 *
 * Option names and types follow the esbuild build API
 * (https://esbuild.github.io/api/). Options that need a real filesystem, a
 * native binary, or esbuild's own tsconfig/package resolver are intentionally
 * omitted: this build runs esbuild-wasm against the workspace VFS and the
 * shared resolver owns import resolution.
 *
 * The legacy "entry" (string) and "outDir" (string) keys are still read and
 * are migrated to "entryPoints" / "outdir" the next time the file is written.
 *
 * When the file is absent, these defaults apply:
 *
 *   {
 *     "entryPoints": ["src/app.ts"],
 *     "outdir": "dist",
 *     "entryNames": undefined,
 *     "chunkNames": undefined,
 *     "outExtension": {},
 *     "format": "esm",
 *     "platform": "browser",
 *     "charset": "ascii",
 *     "minify": false,
 *     "sourcemap": false,
 *     "target": "esnext",
 *     "treeShaking": true,
 *     "keepNames": false,
 *     "legalComments": "eof",
 *     "lineLimit": 0,
 *     "jsx": "transform",
 *     "jsxDev": false,
 *     "jsxSideEffects": false,
 *     "sourcesContent": true,
 *     "drop": [],
 *     "banner": {},
 *     "footer": {},
 *     "pure": [],
 *     "bundle": true,
 *     "splitting": false,
 *     "external": [],
 *     "define": {},
 *     "taggedJsx": "off"
 *   }
 */

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";
import {
  BUILD_FORMATS,
  SOURCEMAP_MODES,
  buildTargetSchema,
  defineSchema,
  optionalStringSchema,
  parseConfig,
  stringListSchema,
  stringRecordSchema,
  withDefault,
  workspacePathListSchema,
  workspacePathSchema,
  type SourcemapOption,
} from "../shared/configSchema.js";

const CONFIG_FILE_NAME = "esbuild.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.esbuild",
  defaultPath: CONFIG_FILE_NAME,
};

const PLATFORMS = ["browser", "node", "neutral"] as const;
const CHARSETS = ["ascii", "utf8"] as const;
const LEGAL_COMMENTS = ["none", "inline", "eof", "linked", "external"] as const;
const JSX_MODES = ["transform", "preserve", "automatic"] as const;
const DROP_ITEMS = ["console", "debugger"] as const;
const TAGGED_JSX_TRANSFORMS = ["off", "toJsx", "toTagged"] as const;

const outputTextSchema = v.object({
  js: optionalStringSchema,
  css: optionalStringSchema,
});

/** Valibot schema for esbuild.config.json. */
export const ESBUILD_CONFIG_SCHEMA = v.object({
  entryPoints: withDefault(workspacePathListSchema, ["src/app.ts"]),
  outdir: withDefault(workspacePathSchema, "dist"),
  entryNames: optionalStringSchema,
  chunkNames: optionalStringSchema,
  outExtension: withDefault(stringRecordSchema, {}),

  format: withDefault(v.picklist(BUILD_FORMATS), "esm"),
  platform: withDefault(v.picklist(PLATFORMS), "browser"),
  charset: withDefault(v.picklist(CHARSETS), "ascii"),
  globalName: optionalStringSchema,

  minify: withDefault(v.boolean(), false),
  sourcemap: withDefault(v.union([v.boolean(), v.picklist(SOURCEMAP_MODES)]), false),
  sourceRoot: optionalStringSchema,
  sourcesContent: withDefault(v.boolean(), true),

  target: withDefault(buildTargetSchema, "esnext"),
  treeShaking: withDefault(v.boolean(), true),
  keepNames: withDefault(v.boolean(), false),
  legalComments: withDefault(v.picklist(LEGAL_COMMENTS), "eof"),
  lineLimit: withDefault(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  drop: withDefault(v.array(v.picklist(DROP_ITEMS)), []),
  banner: withDefault(outputTextSchema, {}),
  footer: withDefault(outputTextSchema, {}),
  pure: withDefault(stringListSchema, []),

  jsx: withDefault(v.picklist(JSX_MODES), "transform"),
  jsxFactory: optionalStringSchema,
  jsxFragment: optionalStringSchema,
  jsxImportSource: optionalStringSchema,
  jsxDev: withDefault(v.boolean(), false),
  jsxSideEffects: withDefault(v.boolean(), false),

  bundle: withDefault(v.boolean(), true),
  splitting: withDefault(v.boolean(), false),
  external: withDefault(stringListSchema, []),
  define: withDefault(defineSchema, {}),
  taggedJsx: withDefault(v.picklist(TAGGED_JSX_TRANSFORMS), "off"),
});

export type EsbuildConfig = v.InferOutput<typeof ESBUILD_CONFIG_SCHEMA>;

export const ESBUILD_DEFAULT_CONFIG: EsbuildConfig = v.parse(ESBUILD_CONFIG_SCHEMA, {});

export type EsbuildSourcemapOption = SourcemapOption;

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.esbuild.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Map the legacy "entry"/"outDir" keys onto their esbuild API names. */
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
 * or unreadable) alongside the parsed config so the panel can rewrite the
 * file without destroying comments-as-JSON-keys or user formatting when
 * possible (we do a plain re-serialization; JSONC is not supported).
 */
export async function readEsbuildConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: EsbuildConfig }> {
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...ESBUILD_DEFAULT_CONFIG } };
  }

  return {
    text,
    config: parseConfig(text, ESBUILD_CONFIG_SCHEMA, ESBUILD_DEFAULT_CONFIG, normalizeLegacyKeys),
  };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateEsbuildConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<EsbuildConfig>,
): Promise<EsbuildConfig> {
  const { text, config } = await readEsbuildConfig(vscode, rootUri);

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
   * (e.g. comments-as-keys, extra tooling fields) survives untouched. Legacy
   * names are dropped so the file converges on the esbuild API shape.
   */
  const { entry: _entry, outDir: _outDir, ...rest } = document;

  const nextDocument: Record<string, unknown> = {
    ...rest,
    entryPoints: merged.entryPoints,
    outdir: merged.outdir,
    entryNames: merged.entryNames,
    chunkNames: merged.chunkNames,
    outExtension: merged.outExtension,
    format: merged.format,
    platform: merged.platform,
    charset: merged.charset,
    globalName: merged.globalName,
    minify: merged.minify,
    sourcemap: merged.sourcemap,
    sourceRoot: merged.sourceRoot,
    sourcesContent: merged.sourcesContent,
    target: merged.target,
    treeShaking: merged.treeShaking,
    keepNames: merged.keepNames,
    legalComments: merged.legalComments,
    lineLimit: merged.lineLimit,
    drop: merged.drop,
    banner: merged.banner,
    footer: merged.footer,
    pure: merged.pure,
    jsx: merged.jsx,
    jsxFactory: merged.jsxFactory,
    jsxFragment: merged.jsxFragment,
    jsxImportSource: merged.jsxImportSource,
    jsxDev: merged.jsxDev,
    jsxSideEffects: merged.jsxSideEffects,
    bundle: merged.bundle,
    splitting: merged.splitting,
    external: merged.external,
    define: merged.define,
    taggedJsx: merged.taggedJsx,
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
