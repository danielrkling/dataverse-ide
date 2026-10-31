import * as v from "valibot";

import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";
import { parseConfig, withDefault, workspacePathSchema } from "../shared/configSchema.js";

/*
 * html.config.json - source of truth for the HTML bundler.
 *
 * The bundler reads an HTML entry file, inlines local references it finds in
 * the markup (scripts, stylesheets, images, SVG, fonts), and writes the
 * resulting self-contained document under `outdir`.
 *
 *   {
 *     "entryPoints": [
 *       "index.html",
 *       { "input": "pages/about.html", "output": "dist/about.html" }
 *     ],
 *     "outdir": "dist",
 *     "inlineScripts": true,
 *     "inlineStyles": true,
 *     "inlineSvg": true,
 *     "inlineImages": true,
 *     "inlineFonts": false,
 *     "inlineCssUrls": true,
 *     "maxInlineBytes": 0,
 *     "minify": false,
 *     "removeComments": false
 *   }
 *
 * `entryPoints` accepts either a workspace-relative string or an object with
 * an explicit `output`. When `output` is omitted the file is written to
 * `<outdir>/<entry file name>`.
 */

const CONFIG_FILE_NAME = "html.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.html",
  defaultPath: CONFIG_FILE_NAME,
};

/** One HTML entry: a path or an input/output pair. */
export const HTML_ENTRY_SCHEMA = v.pipe(
  v.union([
    workspacePathSchema,
    v.object({
      input: workspacePathSchema,
      output: v.optional(workspacePathSchema),
    }),
  ]),
  v.transform((value) => (typeof value === "string" ? { input: value } : value)),
);

export type HtmlEntry = v.InferOutput<typeof HTML_ENTRY_SCHEMA>;

/** One or more entries; invalid items are dropped instead of failing the file. */
export const HTML_ENTRY_POINTS_SCHEMA = v.pipe(
  v.union([HTML_ENTRY_SCHEMA, v.array(v.fallback(HTML_ENTRY_SCHEMA, { input: "" }))]),
  v.transform((value) => (Array.isArray(value) ? value : [value])),
  v.transform((entries) => entries.filter((entry) => entry.input.length > 0)),
  v.check((entries) => entries.length > 0, "Expected at least one HTML entry."),
);

/** Valibot schema for html.config.json. */
export const HTML_CONFIG_SCHEMA = v.object({
  entryPoints: withDefault(HTML_ENTRY_POINTS_SCHEMA, [{ input: "index.html" }]),
  outdir: withDefault(workspacePathSchema, "dist"),

  inlineScripts: withDefault(v.boolean(), true),
  inlineStyles: withDefault(v.boolean(), true),
  inlineSvg: withDefault(v.boolean(), true),
  inlineImages: withDefault(v.boolean(), true),
  inlineFonts: withDefault(v.boolean(), false),
  inlineCssUrls: withDefault(v.boolean(), true),

  /** Skip binary assets larger than this (0 = no limit). */
  maxInlineBytes: withDefault(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),

  minify: withDefault(v.boolean(), false),
  removeComments: withDefault(v.boolean(), false),
});

export type HtmlConfig = v.InferOutput<typeof HTML_CONFIG_SCHEMA>;

export const HTML_DEFAULT_CONFIG: HtmlConfig = v.parse(HTML_CONFIG_SCHEMA, {});

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.html.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/*
 * Read + validate the config file. Returns the raw text (null when absent or
 * unreadable) alongside the parsed config so updateHtmlConfig() can rewrite
 * the file without destroying unknown user keys.
 */
export async function readHtmlConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: HtmlConfig }> {
  let text: string | null = null;

  try {
    const bytes = await vscode.workspace.fs.readFile(configFilePath(vscode, rootUri));

    text = new TextDecoder().decode(bytes);
  } catch {
    return { text: null, config: { ...HTML_DEFAULT_CONFIG } };
  }

  return {
    text,
    config: parseConfig(text, HTML_CONFIG_SCHEMA, HTML_DEFAULT_CONFIG),
  };
}

/*
 * Merge the given partial into the existing file (or defaults when absent)
 * and write it back pretty-printed. Unknown/user keys are preserved.
 */
export async function updateHtmlConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  updates: Partial<HtmlConfig>,
): Promise<HtmlConfig> {
  const { text, config } = await readHtmlConfig(vscode, rootUri);

  let document: Record<string, unknown> = {};

  if (text != null) {
    try {
      document = JSON.parse(text) as Record<string, unknown>;
    } catch {
      document = {};
    }
  }

  const merged: HtmlConfig = { ...config, ...updates };

  const nextDocument: Record<string, unknown> = {
    ...document,
    entryPoints: merged.entryPoints.map((entry) =>
      entry.output == null ? entry.input : { input: entry.input, output: entry.output },
    ),
    outdir: merged.outdir,
    inlineScripts: merged.inlineScripts,
    inlineStyles: merged.inlineStyles,
    inlineSvg: merged.inlineSvg,
    inlineImages: merged.inlineImages,
    inlineFonts: merged.inlineFonts,
    inlineCssUrls: merged.inlineCssUrls,
    maxInlineBytes: merged.maxInlineBytes,
    minify: merged.minify,
    removeComments: merged.removeComments,
  };

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  );

  return merged;
}

/** Default output path for an entry: `<outdir>/<entry file name>`. */
export function defaultOutputPath(input: string, outdir: string): string {
  const fileName = input.split("/").pop() ?? "index.html";

  return `${outdir}/${fileName}`;
}
