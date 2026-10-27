import type * as vscodeType from 'vscode'

/*
 * esbuild.config.json - the source of truth for workspace builds.
 *
 * Same file shape as dataverse-dev-tools so project folders work in both
 * tools. When the file is absent, these defaults apply:
 *
 *   {
 *     "entry": "src/index.ts",
 *     "outDir": ".ide-build",
 *     "format": "esm",
 *     "minify": false,
 *     "sourcemap": false,
 *     "target": "es2022",
 *     "bundle": true,
 *     "external": [],
 *     "define": {},
 *     "watch": false
 *   }
 */

const CONFIG_FILE_NAME = 'esbuild.config.json'

export type EsbuildConfig = {
  entry: string
  outDir: string
  format: 'esm' | 'iife' | 'cjs'
  minify: boolean
  sourcemap: boolean
  target: string
  bundle: boolean
  external: string[]
  define: Record<string, string>
  watch: boolean
}

export const ESBUILD_DEFAULT_CONFIG: EsbuildConfig = {
  entry: 'src/app.ts',
  outDir: 'dist',
  format: 'esm',
  minify: false,
  sourcemap: false,
  target: 'esnext',
  bundle: true,
  external: [],
  define: {},
  watch: false,
}

const FORMATS = new Set(['esm', 'iife', 'cjs'])

export function configFilePath(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): vscodeType.Uri {
  return vscode.Uri.joinPath(rootUri, CONFIG_FILE_NAME)
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
  const defaults = { ...ESBUILD_DEFAULT_CONFIG }

  let text: string | null = null

  try {
    const bytes = await vscode.workspace.fs.readFile(
      configFilePath(vscode, rootUri),
    )

    text = new TextDecoder().decode(bytes)
  } catch {
    return { text: null, config: defaults }
  }

  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { text, config: defaults }
  }

  const config: EsbuildConfig = { ...defaults }

  if (typeof parsed.entry === 'string' && parsed.entry.trim().length > 0) {
    config.entry = parsed.entry.trim().replaceAll('\\', '/')
  }

  if (typeof parsed.outDir === 'string' && parsed.outDir.trim().length > 0) {
    config.outDir = parsed.outDir.trim().replaceAll('\\', '/')
  }

  if (
    typeof parsed.format === 'string' &&
    FORMATS.has(parsed.format)
  ) {
    config.format = parsed.format as EsbuildConfig['format']
  }

  if (typeof parsed.minify === 'boolean') {
    config.minify = parsed.minify
  }

  if (typeof parsed.sourcemap === 'boolean') {
    config.sourcemap = parsed.sourcemap
  }

  if (typeof parsed.target === 'string' && parsed.target.trim().length > 0) {
    config.target = parsed.target.trim()
  }

  if (typeof parsed.bundle === 'boolean') {
    config.bundle = parsed.bundle
  }

  if (Array.isArray(parsed.external)) {
    const externals = parsed.external.filter(
      (entry): entry is string =>
        typeof entry === 'string' && entry.trim().length > 0,
    )

    config.external = externals.map((entry) => entry.trim())
  }

  if (
    parsed.define != null &&
    typeof parsed.define === 'object' &&
    !Array.isArray(parsed.define)
  ) {
    const define: Record<string, string> = {}

    for (const [key, value] of Object.entries(
      parsed.define as Record<string, unknown>,
    )) {
      if (typeof value === 'string') {
        define[key] = value
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        /*
         * esbuild define values must be code snippets; serialize primitives
         * so {"PORT": 3000} becomes PORT=3000 (number literal).
         */
        define[key] = JSON.stringify(value)
      }
    }

    config.define = define
  }

  if (typeof parsed.watch === 'boolean') {
    config.watch = parsed.watch
  }

  return { text, config }
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
  const { text, config } = await readEsbuildConfig(vscode, rootUri)

  let document: Record<string, unknown> = {}

  if (text != null) {
    try {
      document = JSON.parse(text) as Record<string, unknown>
    } catch {
      document = {}
    }
  }

  const merged = { ...config, ...updates }

  /*
   * Only write the managed keys; anything else the user keeps in the file
   * (e.g. comments-as-keys, extra tooling fields) survives untouched.
   */
  const nextDocument: Record<string, unknown> = {
    ...document,
    entry: merged.entry,
    outDir: merged.outDir,
    format: merged.format,
    minify: merged.minify,
    sourcemap: merged.sourcemap,
    target: merged.target,
    bundle: merged.bundle,
    external: merged.external,
    define: merged.define,
    watch: merged.watch,
  }

  await vscode.workspace.fs.writeFile(
    configFilePath(vscode, rootUri),
    new TextEncoder().encode(`${JSON.stringify(nextDocument, null, 2)}\n`),
  )

  return merged
}
