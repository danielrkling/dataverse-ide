import type * as vscodeType from "vscode";

import {
  configFilePathFor,
  configRelativePath,
  type ConfigPathOptions,
} from "../shared/configPath.js";

/*
 * rolldown.config.json - the source of truth for rolldown (oxc wasm)
 * workspace builds, mirroring esbuild.config.json.
 *
 * When the file is absent, these defaults apply:
 *
 *   {
 *     "entry": "src/index.ts",
 *     "outDir": "dist",
 *     "format": "esm",
 *     "minify": false,
 *     "sourcemap": false,
 *     "external": [],
 *     "define": {}
 *   }
 *
 * Differences from esbuild.config.json:
 *   - no "bundle" key: rolldown always bundles (use "external" to keep
 *     bare imports out)
 *   - no "target" key: the oxc wasm pipeline emits modern ES (rolldown has
 *     no esbuild-style target option at this output position)
 *   - format also accepts "umd"
 */

const CONFIG_FILE_NAME = "rolldown.config.json";

export const CONFIG_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.rolldown",
  defaultPath: CONFIG_FILE_NAME,
};

export type RolldownConfig = {
  entry: string;
  outDir: string;
  format: "esm" | "iife" | "cjs" | "umd";
  minify: boolean;
  sourcemap: boolean;
  external: string[];
  define: Record<string, string>;
  /**
   * Solid 2.0 toolchain: "v2" compiles workspace .jsx/.tsx with
   * @solidjs/compiler-wasm32-wasi; "off" uses the default oxc loaders;
   * "auto" (default) detects solid-js@2.x from the workspace node_modules
   * manifests at build time.
   */
  solid: "auto" | "v2" | "off";
};

export const ROLLDOWN_DEFAULT_CONFIG: RolldownConfig = {
  entry: "src/index.ts",
  outDir: "dist",
  format: "esm",
  minify: false,
  sourcemap: false,
  external: [],
  define: {},
  solid: "auto",
};

const FORMATS = new Set(["esm", "iife", "cjs", "umd"]);

export function configFilePath(vscode: typeof vscodeType, rootUri: vscodeType.Uri): vscodeType.Uri {
  return configFilePathFor(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/** Workspace-relative config path (honors dataverseIde.rolldown.configPath). */
export function configRelativePathFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri): string {
  return configRelativePath(vscode, rootUri, CONFIG_PATH_OPTIONS);
}

/*
 * Read + validate the config file. Returns the raw text (null when absent
 * or unreadable) alongside the parsed config.
 */
export async function readRolldownConfig(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ text: string | null; config: RolldownConfig }> {
  const defaults = { ...ROLLDOWN_DEFAULT_CONFIG };

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

  const config: RolldownConfig = { ...defaults };

  if (typeof parsed.entry === "string" && parsed.entry.trim().length > 0) {
    /*
     * Canonicalize: workspace paths are stored slash-normalized without a
     * leading './' (the collected files map keys carry no './' prefix), so
     * "entry": "./src/index.ts" must become "src/index.ts" or lookup fails.
     */
    config.entry = parsed.entry
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(?:\.{1,2}\/)+/, "");
  }

  if (typeof parsed.outDir === "string" && parsed.outDir.trim().length > 0) {
    config.outDir = parsed.outDir.trim().replaceAll("\\", "/");
  }

  if (typeof parsed.format === "string" && FORMATS.has(parsed.format)) {
    config.format = parsed.format as RolldownConfig["format"];
  }

  if (typeof parsed.minify === "boolean") {
    config.minify = parsed.minify;
  }

  if (typeof parsed.sourcemap === "boolean") {
    config.sourcemap = parsed.sourcemap;
  }

  if (Array.isArray(parsed.external)) {
    const externals = parsed.external.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );

    config.external = externals.map((entry) => entry.trim());
  }

  if (
    typeof parsed.solid === "string" &&
    (parsed.solid === "auto" || parsed.solid === "v2" || parsed.solid === "off")
  ) {
    config.solid = parsed.solid;
  }

  if (parsed.define != null && typeof parsed.define === "object" && !Array.isArray(parsed.define)) {
    const define: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed.define as Record<string, unknown>)) {
      if (typeof value === "string") {
        define[key] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        /*
         * Define values must be code snippets; serialize primitives so
         * {"PORT": 3000} becomes PORT=3000 (number literal).
         */
        define[key] = JSON.stringify(value);
      }
    }

    config.define = define;
  }

  return { text, config };
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
   * survives untouched.
   */
  const nextDocument: Record<string, unknown> = {
    ...document,
    entry: merged.entry,
    outDir: merged.outDir,
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
