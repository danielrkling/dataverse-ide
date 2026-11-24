import * as v from "valibot";

import type * as vscodeType from "vscode";

/*
 * esbuild.config.json - the source of truth for workspace builds.
 *
 * Option names and types follow the esbuild build API
 * (https://esbuild.github.io/api/). Options that need a native binary or a
 * real operating-system filesystem are still resolved through the workspace
 * VFS, but their esbuild semantics (platform-aware conditions, main fields,
 * tsconfig paths, extension resolution, and so on) are implemented by the
 * shared resolver.
 *
 * When the file is absent, these defaults apply:
 *
 *   {
 *     "entryPoints": ["src/app.ts"],
 *     "outdir": "dist",
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
 *     "jsx": undefined,
 *     "jsxDev": false,
 *     "jsxSideEffects": false,
 *     "sourcesContent": true,
 *     "bundle": true,
 *     "splitting": false,
 *     "packages": "bundle",
 *     "allowOverwrite": false,
 *     "solid": "off"
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
const SOLID_COMPILERS = ["off", "v1", "v2"] as const;

const outputTextSchema = v.object({
  js: optionalStringSchema,
  css: optionalStringSchema,
});

const entryPointSchema = v.union([
  workspacePathSchema,
  v.object({
    in: workspacePathSchema,
    out: optionalStringSchema,
  }),
]);

const entryPointListSchema = v.pipe(
  v.union([entryPointSchema, v.array(entryPointSchema)]),
  v.transform((value) => (Array.isArray(value) ? value : [value])),
  v.check((items) => items.length > 0, "Expected at least one entry point."),
);

const bannerFooterSchema = v.union([v.string(), outputTextSchema]);

const supportedSchema = v.pipe(
  v.record(v.string(), v.unknown()),
  v.transform((record) =>
    Object.fromEntries(
      Object.entries(record).filter((entry): entry is [string, boolean] => {
        return typeof entry[1] === "boolean" && entry[0].trim().length > 0;
      }),
    ),
  ),
);

/** Valibot schema for esbuild.config.json. */
export const ESBUILD_CONFIG_SCHEMA = v.object({
  entryPoints: withDefault(entryPointListSchema, ["src/app.ts"]),
  outdir: withDefault(workspacePathSchema, "dist"),
  outfile: optionalStringSchema,
  outbase: optionalStringSchema,
  entryNames: optionalStringSchema,
  chunkNames: optionalStringSchema,
  assetNames: optionalStringSchema,
  publicPath: optionalStringSchema,
  outExtension: withDefault(stringRecordSchema, {}),
  allowOverwrite: withDefault(v.boolean(), false),

  format: withDefault(v.picklist(BUILD_FORMATS), "esm"),
  platform: withDefault(v.picklist(PLATFORMS), "browser"),
  charset: withDefault(v.picklist(CHARSETS), "ascii"),
  globalName: optionalStringSchema,

  minify: withDefault(v.boolean(), false),
  minifyWhitespace: withDefault(v.boolean(), false),
  minifyIdentifiers: withDefault(v.boolean(), false),
  minifySyntax: withDefault(v.boolean(), false),
  sourcemap: withDefault(v.union([v.boolean(), v.picklist(SOURCEMAP_MODES)]), false),
  sourceRoot: optionalStringSchema,
  sourcesContent: withDefault(v.boolean(), true),

  target: withDefault(buildTargetSchema, "esnext"),
  treeShaking: withDefault(v.boolean(), true),
  ignoreAnnotations: withDefault(v.boolean(), false),
  keepNames: withDefault(v.boolean(), false),
  legalComments: withDefault(v.picklist(LEGAL_COMMENTS), "eof"),
  lineLimit: withDefault(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  drop: withDefault(v.array(v.picklist(DROP_ITEMS)), []),
  dropLabels: withDefault(stringListSchema, []),
  banner: withDefault(bannerFooterSchema, {}),
  footer: withDefault(bannerFooterSchema, {}),
  pure: withDefault(stringListSchema, []),
  mangleProps: optionalStringSchema,
  reserveProps: optionalStringSchema,

  /*
   * Left undefined by default so tsconfig.json compilerOptions.jsx can take
   * effect. esbuild's own default is "transform" when neither is set.
   */
  jsx: v.optional(v.picklist(JSX_MODES)),
  jsxFactory: optionalStringSchema,
  jsxFragment: optionalStringSchema,
  jsxImportSource: optionalStringSchema,
  jsxDev: withDefault(v.boolean(), false),
  jsxSideEffects: withDefault(v.boolean(), false),
  supported: withDefault(supportedSchema, {}),

  bundle: withDefault(v.boolean(), true),
  splitting: withDefault(v.boolean(), false),
  external: withDefault(stringListSchema, []),
  alias: withDefault(stringRecordSchema, {}),
  define: withDefault(defineSchema, {}),
  loader: withDefault(stringRecordSchema, {}),
  inject: withDefault(workspacePathListSchema, []),
  tsconfig: optionalStringSchema,
  tsconfigRaw: v.optional(v.union([v.string(), v.record(v.string(), v.unknown())])),

  conditions: v.optional(stringListSchema),
  mainFields: v.optional(stringListSchema),
  resolveExtensions: v.optional(stringListSchema),
  nodePaths: withDefault(workspacePathListSchema, []),
  packages: withDefault(v.picklist(["bundle", "external"] as const), "bundle"),

  solid: withDefault(v.picklist(SOLID_COMPILERS), "off"),
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
    config: parseConfig(text, ESBUILD_CONFIG_SCHEMA, ESBUILD_DEFAULT_CONFIG),
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
   * (e.g. comments-as-keys, extra tooling fields) survives untouched. The old
   * "entry"/"outDir" aliases are dropped rather than migrated.
   */
  const { entry: _entry, outDir: _outDir, ...rest } = document;

  const nextDocument: Record<string, unknown> = {
    ...rest,
    entryPoints: merged.entryPoints,
    outdir: merged.outdir,
    outfile: merged.outfile,
    outbase: merged.outbase,
    entryNames: merged.entryNames,
    chunkNames: merged.chunkNames,
    assetNames: merged.assetNames,
    publicPath: merged.publicPath,
    outExtension: merged.outExtension,
    allowOverwrite: merged.allowOverwrite,
    format: merged.format,
    platform: merged.platform,
    charset: merged.charset,
    globalName: merged.globalName,
    minify: merged.minify,
    minifyWhitespace: merged.minifyWhitespace,
    minifyIdentifiers: merged.minifyIdentifiers,
    minifySyntax: merged.minifySyntax,
    sourcemap: merged.sourcemap,
    sourceRoot: merged.sourceRoot,
    sourcesContent: merged.sourcesContent,
    target: merged.target,
    treeShaking: merged.treeShaking,
    ignoreAnnotations: merged.ignoreAnnotations,
    keepNames: merged.keepNames,
    legalComments: merged.legalComments,
    lineLimit: merged.lineLimit,
    drop: merged.drop,
    dropLabels: merged.dropLabels,
    banner: merged.banner,
    footer: merged.footer,
    pure: merged.pure,
    mangleProps: merged.mangleProps,
    reserveProps: merged.reserveProps,
    jsx: merged.jsx,
    jsxFactory: merged.jsxFactory,
    jsxFragment: merged.jsxFragment,
    jsxImportSource: merged.jsxImportSource,
    jsxDev: merged.jsxDev,
    jsxSideEffects: merged.jsxSideEffects,
    supported: merged.supported,
    bundle: merged.bundle,
    splitting: merged.splitting,
    external: merged.external,
    alias: merged.alias,
    define: merged.define,
    loader: merged.loader,
    inject: merged.inject,
    tsconfig: merged.tsconfig,
    tsconfigRaw: merged.tsconfigRaw,
    conditions: merged.conditions,
    mainFields: merged.mainFields,
    resolveExtensions: merged.resolveExtensions,
    nodePaths: merged.nodePaths,
    packages: merged.packages,
    solid: merged.solid,
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}
