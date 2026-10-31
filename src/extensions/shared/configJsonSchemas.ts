import { toJsonSchema, type JsonSchema } from "@valibot/to-json-schema";
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

import type { BaseIssue, BaseSchema } from "valibot";

import { DATAVERSE_CONFIG_SCHEMA } from "../dataverse/config.js";
import { ESBUILD_CONFIG_SCHEMA } from "../esbuild/config.js";
import { HTML_CONFIG_SCHEMA } from "../html/config.js";
import { ROLLDOWN_CONFIG_SCHEMA } from "../rolldown/config.js";
import { ROLLUP_CONFIG_SCHEMA } from "../rollup/config.js";
import { TAILWIND_CONFIG_SCHEMA } from "../tailwind/config.js";
import { defineRecordSchema } from "./configSchema.js";

/*
 * JSON Schemas for the project config files.
 *
 * These are generated from the same Valibot schemas the runtime readers use,
 * then exposed as a virtual extension's "jsonValidation" contribution (see
 * registerConfigJsonSchemas below). That gives each config file:
 *   - validation (unknown keys, wrong types, bad enum values)
 *   - property/value completion
 *   - hover documentation from descriptions/defaults
 *
 * Keep the fileMatch patterns in sync with the default config file names; a
 * renamed config path (dataverseIde.<feature>.configPath) is still validated
 * at runtime, but the JSON language service only knows the default names.
 */

type ConfigJsonSchemaEntry = {
  fileMatch: string[];
  schema: JsonSchema;
};

type MutableJsonSchema = Record<string, unknown>;

const SCHEMA_OVERRIDES = new WeakMap<
  BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  JsonSchema
>();

/*
 * defineRecordSchema deliberately accepts unknown values at runtime so
 * defineSchema can drop unsupported entries. Its JSON Schema equivalent is a
 * typed map.
 */
SCHEMA_OVERRIDES.set(defineRecordSchema, {
  type: "object",
  additionalProperties: {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
  },
});

function jsonSchemaFor(schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>): JsonSchema {
  return toJsonSchema(schema, {
    errorMode: "ignore",
    overrideSchema: ({ valibotSchema }) => SCHEMA_OVERRIDES.get(valibotSchema),
  });
}

function describeProperties(schema: JsonSchema, descriptions: Record<string, string>): JsonSchema {
  const properties = schema.properties;

  if (properties == null || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }

  const records = properties as Record<string, unknown>;

  for (const [key, description] of Object.entries(descriptions)) {
    const property = records[key];

    if (property != null && typeof property === "object" && !Array.isArray(property)) {
      const record = property as MutableJsonSchema;

      record.description ??= description;
    }
  }

  return schema;
}

function schemaEntry(
  title: string,
  fileMatch: string[],
  schema: JsonSchema,
  descriptions: Record<string, string>,
): ConfigJsonSchemaEntry {
  return {
    fileMatch,
    schema: {
      ...describeProperties(schema, descriptions),
      title,
    },
  };
}

const SCHEMA_DIRECTORY = "config-schemas";

function toSchemaDataUrl(schema: JsonSchema): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(schema))}`;
}

/*
 * The JSON language client reads schema associations from two places:
 *   - explicit "json.schemas" setting values (global/workspace/folder)
 *   - the "jsonValidation" contribution of every installed extension
 *
 * Configuration *defaults* are not part of "json.schemas" (its client only
 * inspects explicit values), so the schemas are exposed as a tiny virtual
 * extension contribution instead. Schema files are registered through
 * registerFileUrl(), so no files are written to the workspace.
 */
export function registerConfigJsonSchemas(): { dispose(): void } {
  const { registerFileUrl } = registerExtension(
    {
      name: "dataverse-ide-config-schemas",
      publisher: "dataverse-ide",
      version: "0.1.0",
      engines: { vscode: "*" },
      displayName: "Dataverse IDE Config Schemas",
      description: "JSON validation and IntelliSense for dataverse-ide config files.",
      contributes: {
        jsonValidation: CONFIG_JSON_SCHEMAS.map((entry, index) => ({
          fileMatch: entry.fileMatch,
          url: `./${SCHEMA_DIRECTORY}/${index}.json`,
        })),
      },
    } as never,
    ExtensionHostKind.LocalProcess,
  );

  const fileDisposables = CONFIG_JSON_SCHEMAS.map((entry, index) =>
    registerFileUrl(
      `${SCHEMA_DIRECTORY}/${index}.json`,
      toSchemaDataUrl(entry.schema),
      "application/json",
    ),
  );

  return {
    dispose() {
      for (const fileDisposable of fileDisposables) {
        fileDisposable.dispose();
      }
    },
  };
}

export const CONFIG_JSON_SCHEMAS: ConfigJsonSchemaEntry[] = [
  schemaEntry(
    "dataverse.config.json",
    ["dataverse.config.json"],
    jsonSchemaFor(DATAVERSE_CONFIG_SCHEMA),
    {
      prefix: "Web resource name prefix (for example dv_/ide).",
      solution: "Optional solution unique name to associate uploaded web resources with.",
      uploadRoot: "Workspace-relative root directory scanned for upload files.",
      files: "Workspace-relative glob patterns to upload.",
      exclude: "Workspace-relative glob patterns to exclude from upload.",
      publishAfterUpload: "Publish the web resources after a successful upload.",
      apiBaseUrl: "Optional Dataverse base URL; defaults to the current origin.",
    },
  ),

  schemaEntry(
    "esbuild.config.json",
    ["esbuild.config.json"],
    jsonSchemaFor(ESBUILD_CONFIG_SCHEMA),
    {
      entryPoints: "Workspace-relative entry files (esbuild entryPoints).",
      outdir: "Workspace-relative output directory (esbuild outdir).",
      entryNames: "Entry output name template (for example [dir]/[name]-[hash]).",
      chunkNames: "Code-split chunk output name template.",
      outExtension: 'Override output extensions, for example { ".js": ".mjs" }.',
      format: "Output module format (esm, iife, or cjs).",
      platform: "Target platform (browser, node, or neutral).",
      charset: "Escape non-ASCII characters (ascii) or keep UTF-8 output.",
      globalName: "Global variable name for iife exports.",
      minify: "Minify the generated JavaScript.",
      sourcemap: "Source map mode (esbuild sourcemap).",
      sourceRoot: "Value written to the source map's sourceRoot field.",
      sourcesContent: "Embed original sources in source maps.",
      target: "Output target environment(s) (esbuild target).",
      treeShaking: "Enable dead-code elimination.",
      keepNames: "Preserve function and class names.",
      legalComments: "How to preserve @license/@preserve legal comments.",
      lineLimit: "Wrap output lines after roughly this many bytes (0 = disabled).",
      drop: "Drop console calls and/or debugger statements.",
      banner: "Text prepended to generated JS and/or CSS files.",
      footer: "Text appended to generated JS and/or CSS files.",
      pure: "Function calls to mark as side-effect free for tree shaking.",
      jsx: "JSX transform mode (transform, preserve, or automatic).",
      jsxFactory: "Function used for JSX elements with the transform mode.",
      jsxFragment: "Function used for JSX fragments with the transform mode.",
      jsxImportSource: "Package imported by the automatic JSX transform.",
      jsxDev: "Add source location information to automatic JSX calls.",
      jsxSideEffects: "Treat JSX expressions as having side effects.",
      bundle: "Inline imported dependencies into the output.",
      splitting: "Split shared code into chunks (requires esm format).",
      external: "Packages or paths to leave external.",
      define: "Build-time global identifier replacements.",
      taggedJsx: "Tagged-JSX transform applied before esbuild loaders.",
      solid:
        'Solid JSX compiler: "v1" (babel-preset-solid) or "v2" (@solidjs/babel-plugin); "off" leaves JSX to esbuild.',
    },
  ),

  schemaEntry("html.config.json", ["html.config.json"], jsonSchemaFor(HTML_CONFIG_SCHEMA), {
    entryPoints:
      "HTML entry files, or input/output objects. Outputs default to <outdir>/<file name>.",
    outdir: "Workspace-relative output directory for bundled HTML.",
    inlineScripts: "Inline local <script src> files.",
    inlineStyles: "Inline local stylesheets (including nested @import rules).",
    inlineSvg: "Inline local SVG assets as data URIs.",
    inlineImages: "Inline local image assets as data URIs.",
    inlineFonts: "Inline local font files referenced from CSS.",
    inlineCssUrls: "Inline local url() assets inside stylesheets and <style> blocks.",
    maxInlineBytes: "Skip binary assets larger than this many bytes (0 = no limit).",
    minify: "Collapse HTML whitespace while preserving script/style/pre/textarea content.",
    removeComments: "Remove non-conditional HTML comments.",
    external:
      "Glob patterns of workspace paths or original references to leave un-inlined (for example vendor/**, *.min.js). Patterns without a slash match the file name.",
  }),

  schemaEntry(
    "rolldown.config.json",
    ["rolldown.config.json"],
    jsonSchemaFor(ROLLDOWN_CONFIG_SCHEMA),
    {
      entryPoints: "Workspace-relative entry files.",
      outdir: "Workspace-relative output directory.",
      format: "Output module format (esm, iife, cjs, or umd).",
      minify: "Minify the generated JavaScript.",
      sourcemap: "Emit an inline source map.",
      external: "Packages or paths to leave external.",
      define: "Build-time global identifier replacements.",
      solid: "Solid 2.x toolchain selection (auto, v2, or off).",
    },
  ),

  schemaEntry("rollup.config.json", ["rollup.config.json"], jsonSchemaFor(ROLLUP_CONFIG_SCHEMA), {
    entryPoints: "Workspace-relative entry files.",
    outdir: "Workspace-relative output directory.",
    format: "Output module format (esm, iife, cjs, or umd).",
    minify: "Minify the generated JavaScript.",
    sourcemap: "Emit source maps through Rollup's output pipeline.",
    external: "Packages or paths to leave external.",
    define: "Build-time global identifier replacements.",
  }),

  schemaEntry(
    "tailwind.config.json",
    ["tailwind.config.json"],
    jsonSchemaFor(TAILWIND_CONFIG_SCHEMA),
    {
      input: 'Workspace CSS entry. Empty uses the default @import "tailwindcss"; entry.',
      output: "Workspace-relative compiled CSS output path.",
      minify: "Minify the compiled CSS.",
    },
  ),
];
