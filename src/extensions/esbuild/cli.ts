/*
 * esbuild CLI-style argument parsing for the terminal command.
 *
 * Supports the subset of https://esbuild.github.io/api/ that maps onto the
 * workspace build config. Unknown flags fail instead of being silently
 * ignored, so a typo does not produce a surprising build.
 */

import type { EsbuildConfig } from "./config.js";

const FORMATS = new Set(["esm", "iife", "cjs"]);
const PLATFORMS = new Set(["browser", "node", "neutral"]);
const CHARSETS = new Set(["ascii", "utf8"]);
const LEGAL_COMMENTS = new Set(["none", "inline", "eof", "linked", "external"]);
const JSX_MODES = new Set(["transform", "preserve", "automatic"]);
const SOURCEMAP_MODES = new Set(["inline", "external", "both", "linked"]);
const DROP_ITEMS = new Set(["console", "debugger"]);

const VALUE_FLAGS = new Set([
  "format",
  "platform",
  "charset",
  "global-name",
  "target",
  "legal-comments",
  "line-limit",
  "source-root",
  "jsx",
  "jsx-factory",
  "jsx-fragment",
  "jsx-import-source",
  "entry-names",
  "chunk-names",
  "asset-names",
  "public-path",
  "outbase",
  "outdir",
  "outfile",
  "tsconfig",
  "tsconfig-raw",
  "mangle-props",
  "reserve-props",
  "packages",
  "conditions",
  "main-fields",
  "resolve-extensions",
  "node-paths",
  "drop-labels",
]);

export type EsbuildCliResult = {
  entries: string[];
  override: Partial<EsbuildConfig>;
  help?: boolean;
  error?: string;
};

type MutableResult = {
  entries: string[];
  override: Partial<EsbuildConfig>;
  help: boolean;
  error?: string;
};

function fail(result: MutableResult, message: string): EsbuildCliResult {
  result.error = message;

  return result;
}

function booleanValue(name: string, value: string | undefined): boolean | string {
  if (value == null) {
    return true;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return `--${name} expects true or false`;
}

function readValue(
  name: string,
  inline: string | undefined,
  args: string[],
  index: number,
): { value: string; index: number } | string {
  if (inline != null) {
    return { value: inline, index };
  }

  const next = args[index + 1];

  if (next == null || next.startsWith("-")) {
    return `--${name} requires a value`;
  }

  return { value: next, index: index + 1 };
}

function workspaceRelativePath(value: string, name: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");

  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return undefined;
  }

  return normalized.length > 0 ? normalized : name === "outdir" ? "." : undefined;
}

function pushListValue(
  result: MutableResult,
  key: "conditions" | "mainFields" | "resolveExtensions" | "nodePaths" | "dropLabels",
  value: string,
): void {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  (result.override as Record<string, unknown>)[key] = [
    ...((result.override[key] as string[] | undefined) ?? []),
    ...items,
  ];
}

export function parseEsbuildCliArgs(args: string[]): EsbuildCliResult {
  const result: MutableResult = {
    entries: [],
    override: {},
    help: false,
  };
  let outfile: string | undefined;
  let outdir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--") {
      result.entries.push(...args.slice(index + 1));
      break;
    }

    if (!argument.startsWith("-")) {
      result.entries.push(argument);
      continue;
    }

    const equals = argument.indexOf("=");
    const head = equals >= 0 ? argument.slice(0, equals) : argument;
    const inline = equals >= 0 ? argument.slice(equals + 1) : undefined;
    const name = head.replace(/^--?/, "");

    if (name === "help" || name === "h") {
      result.help = true;
      continue;
    }

    if (name.startsWith("define:")) {
      const key = name.slice("define:".length);
      const value = inline ?? "";

      if (key.length === 0 || value.length === 0) {
        return fail(result, "--define requires --define:KEY=VALUE");
      }

      result.override.define = {
        ...(result.override.define ?? {}),
        [key]: value,
      };
      continue;
    }

    if (name.startsWith("external:")) {
      const value = name.slice("external:".length);

      if (value.length === 0) {
        return fail(result, "--external requires --external:PACKAGE");
      }

      result.override.external = [...(result.override.external ?? []), value];
      continue;
    }

    if (name.startsWith("alias:")) {
      const key = name.slice("alias:".length);
      const target = inline ?? "";

      if (key.length === 0 || target.length === 0) {
        return fail(result, "--alias requires --alias:PACKAGE=TARGET");
      }

      result.override.alias = {
        ...(result.override.alias ?? {}),
        [key]: target,
      };
      continue;
    }

    if (name.startsWith("inject:")) {
      const value = name.slice("inject:".length);

      if (value.length === 0) {
        return fail(result, "--inject requires --inject:FILE");
      }

      result.override.inject = [...(result.override.inject ?? []), value];
      continue;
    }

    if (name.startsWith("supported:")) {
      const key = name.slice("supported:".length);
      const raw = inline ?? "";

      if (key.length === 0 || (raw !== "true" && raw !== "false")) {
        return fail(result, "--supported requires --supported:FEATURE=true|false");
      }

      result.override.supported = {
        ...(result.override.supported ?? {}),
        [key]: raw === "true",
      };
      continue;
    }

    if (name.startsWith("pure:")) {
      const value = name.slice("pure:".length);

      if (value.length === 0) {
        return fail(result, "--pure requires --pure:EXPRESSION");
      }

      result.override.pure = [...(result.override.pure ?? []), value];
      continue;
    }

    if (name.startsWith("drop:")) {
      const value = name.slice("drop:".length);

      if (!DROP_ITEMS.has(value)) {
        return fail(result, "--drop supports console or debugger");
      }

      const drop = new Set([...(result.override.drop ?? []), value as "console" | "debugger"]);
      result.override.drop = [...drop];
      continue;
    }

    if (name.startsWith("loader:")) {
      const extension = name.slice("loader:".length);
      const value = inline ?? "";

      if (extension.length === 0 || value.length === 0) {
        return fail(result, "--loader requires --loader:.ext=LOADER");
      }

      result.override.loader = {
        ...(result.override.loader ?? {}),
        [extension]: value,
      };
      continue;
    }

    if (name.startsWith("banner:") || name.startsWith("footer:")) {
      const kind = name.startsWith("banner:") ? "banner" : "footer";
      const target = name.slice(kind.length + 1);

      if (target !== "js" && target !== "css") {
        return fail(result, `--${kind} supports js or css`);
      }

      if (inline == null || inline.length === 0) {
        return fail(result, `--${kind}:${target} requires a value`);
      }

      const current = result.override[kind];
      const currentObject = current != null && typeof current === "object" ? current : {};

      result.override[kind] = {
        ...currentObject,
        [target]: inline,
      };
      continue;
    }

    if (name.startsWith("out-extension:")) {
      const extension = name.slice("out-extension:".length);
      const value = inline ?? "";

      if (extension.length === 0 || value.length === 0) {
        return fail(result, "--out-extension requires --out-extension:.js=.mjs");
      }

      result.override.outExtension = {
        ...(result.override.outExtension ?? {}),
        [extension]: value,
      };
      continue;
    }

    /*
     * Boolean flags.
     */
    const booleanFlags: Record<string, keyof EsbuildConfig> = {
      bundle: "bundle",
      minify: "minify",
      "minify-whitespace": "minifyWhitespace",
      "minify-identifiers": "minifyIdentifiers",
      "minify-syntax": "minifySyntax",
      splitting: "splitting",
      "keep-names": "keepNames",
      "ignore-annotations": "ignoreAnnotations",
      "jsx-dev": "jsxDev",
      "jsx-side-effects": "jsxSideEffects",
      "sources-content": "sourcesContent",
      "tree-shaking": "treeShaking",
      "allow-overwrite": "allowOverwrite",
    };
    const negated = name.startsWith("no-");
    const booleanName = negated ? name.slice(3) : name;
    const booleanKey = booleanFlags[booleanName];

    if (booleanKey != null) {
      const parsed = booleanValue(booleanName, inline);

      if (typeof parsed === "string") {
        return fail(result, parsed);
      }

      (result.override as Record<string, unknown>)[booleanKey] = negated ? !parsed : parsed;
      continue;
    }

    if (name === "no-sourcemap") {
      result.override.sourcemap = false;
      continue;
    }

    if (name === "sourcemap") {
      if (inline == null) {
        result.override.sourcemap = true;
      } else if (inline === "true" || inline === "false") {
        result.override.sourcemap = inline === "true";
      } else if (SOURCEMAP_MODES.has(inline)) {
        result.override.sourcemap = inline as EsbuildConfig["sourcemap"];
      } else {
        return fail(result, "--sourcemap supports inline, external, both or linked");
      }
      continue;
    }

    /*
     * Value flags.
     */
    if (!VALUE_FLAGS.has(name)) {
      return fail(result, `unsupported esbuild option --${name}`);
    }

    const value = readValue(name, inline, args, index);

    if (typeof value === "string") {
      return fail(result, value);
    }

    index = value.index;

    switch (name) {
      case "format":
        if (!FORMATS.has(value.value)) {
          return fail(result, "--format supports esm, iife or cjs");
        }
        result.override.format = value.value as EsbuildConfig["format"];
        break;

      case "platform":
        if (!PLATFORMS.has(value.value)) {
          return fail(result, "--platform supports browser, node or neutral");
        }
        result.override.platform = value.value as EsbuildConfig["platform"];
        break;

      case "charset":
        if (!CHARSETS.has(value.value)) {
          return fail(result, "--charset supports ascii or utf8");
        }
        result.override.charset = value.value as EsbuildConfig["charset"];
        break;

      case "global-name":
        result.override.globalName = value.value;
        break;

      case "target":
        result.override.target = value.value;
        break;

      case "legal-comments":
        if (!LEGAL_COMMENTS.has(value.value)) {
          return fail(result, "--legal-comments supports none, inline, eof, linked or external");
        }
        result.override.legalComments = value.value as EsbuildConfig["legalComments"];
        break;

      case "line-limit": {
        const limit = Number(value.value);

        if (!Number.isInteger(limit) || limit < 0) {
          return fail(result, "--line-limit expects a non-negative integer");
        }

        result.override.lineLimit = limit;
        break;
      }

      case "source-root":
        result.override.sourceRoot = value.value;
        break;

      case "jsx":
        if (!JSX_MODES.has(value.value)) {
          return fail(result, "--jsx supports transform, preserve or automatic");
        }
        result.override.jsx = value.value as EsbuildConfig["jsx"];
        break;

      case "jsx-factory":
        result.override.jsxFactory = value.value;
        break;

      case "jsx-fragment":
        result.override.jsxFragment = value.value;
        break;

      case "jsx-import-source":
        result.override.jsxImportSource = value.value;
        break;

      case "entry-names":
        result.override.entryNames = value.value;
        break;

      case "chunk-names":
        result.override.chunkNames = value.value;
        break;

      case "asset-names":
        result.override.assetNames = value.value;
        break;

      case "public-path":
        result.override.publicPath = value.value;
        break;

      case "outbase": {
        const normalized = workspaceRelativePath(value.value, "outbase");

        if (normalized == null) {
          return fail(result, "outbase must be a workspace-relative path");
        }

        result.override.outbase = normalized;
        break;
      }

      case "tsconfig": {
        const normalized = workspaceRelativePath(value.value, "tsconfig");

        if (normalized == null) {
          return fail(result, "tsconfig must be a workspace-relative path");
        }

        result.override.tsconfig = normalized;
        break;
      }

      case "tsconfig-raw":
        result.override.tsconfigRaw = value.value;
        break;

      case "mangle-props":
        result.override.mangleProps = value.value;
        break;

      case "reserve-props":
        result.override.reserveProps = value.value;
        break;

      case "packages":
        if (value.value !== "bundle" && value.value !== "external") {
          return fail(result, "--packages supports bundle or external");
        }
        result.override.packages = value.value;
        break;

      case "conditions":
        pushListValue(result, "conditions", value.value);
        break;

      case "main-fields":
        pushListValue(result, "mainFields", value.value);
        break;

      case "resolve-extensions":
        pushListValue(result, "resolveExtensions", value.value);
        break;

      case "node-paths":
        pushListValue(result, "nodePaths", value.value);
        break;

      case "drop-labels":
        pushListValue(result, "dropLabels", value.value);
        break;

      case "outdir":
        outdir = value.value;
        break;

      case "outfile":
        outfile = value.value;
        break;

      default:
        return fail(result, `unsupported esbuild option --${name}`);
    }
  }

  if (outfile != null && outdir != null) {
    return fail(result, "--outfile and --outdir cannot be used together");
  }

  if (outfile != null) {
    if (result.entries.length === 0) {
      return fail(result, "--outfile requires an entry point");
    }

    if (result.entries.length > 1) {
      return fail(result, "--outfile only supports one entry point");
    }

    const normalized = workspaceRelativePath(outfile, "outfile");

    if (normalized == null) {
      return fail(result, "outfile must be a workspace-relative path");
    }

    result.override.outfile = normalized;
  }

  if (outdir != null) {
    const normalized = workspaceRelativePath(outdir, "outdir");

    if (normalized == null) {
      return fail(result, "outdir must be a workspace-relative path");
    }

    result.override.outdir = normalized;
  }

  return result;
}

/**
 * Merge CLI values over the file config. Lists append and maps merge; scalars
 * replace. This keeps workspace defaults such as external packages or defines
 * available to a one-off CLI build.
 */
function mergeOutputText(
  base: EsbuildConfig["banner"],
  override: Partial<EsbuildConfig>["banner"],
): EsbuildConfig["banner"] {
  if (override == null) {
    return base;
  }

  if (typeof override === "string" || typeof base === "string") {
    return override;
  }

  return { ...base, ...override };
}

export function mergeEsbuildOverride(
  base: EsbuildConfig,
  override: Partial<EsbuildConfig>,
): EsbuildConfig {
  return {
    ...base,
    ...override,
    /*
     * outdir/outfile are mutually exclusive in esbuild. A CLI outdir replaces
     * a configured outfile instead of being silently ignored by the compiler.
     */
    outfile:
      override.outfile != null
        ? override.outfile
        : override.outdir != null
          ? undefined
          : base.outfile,
    external: override.external != null ? [...base.external, ...override.external] : base.external,
    pure: override.pure != null ? [...base.pure, ...override.pure] : base.pure,
    drop: override.drop != null ? [...new Set([...base.drop, ...override.drop])] : base.drop,
    dropLabels:
      override.dropLabels != null
        ? [...new Set([...base.dropLabels, ...override.dropLabels])]
        : base.dropLabels,
    inject: override.inject != null ? [...base.inject, ...override.inject] : base.inject,
    nodePaths:
      override.nodePaths != null
        ? [...new Set([...base.nodePaths, ...override.nodePaths])]
        : base.nodePaths,
    define: override.define != null ? { ...base.define, ...override.define } : base.define,
    alias: override.alias != null ? { ...base.alias, ...override.alias } : base.alias,
    loader: override.loader != null ? { ...base.loader, ...override.loader } : base.loader,
    outExtension:
      override.outExtension != null
        ? { ...base.outExtension, ...override.outExtension }
        : base.outExtension,
    supported:
      override.supported != null ? { ...base.supported, ...override.supported } : base.supported,
    banner: mergeOutputText(base.banner, override.banner),
    footer: mergeOutputText(base.footer, override.footer),
  };
}
