/*
 * Tailwind workspace compiler.
 *
 * Uses the real Tailwind v4 `compile()` API from the bundled `tailwindcss`
 * package (pure JS in the browser — the oxide scanner is not required when
 * candidates are supplied directly to `compiler.build()`, the same approach
 * dataverse-dev-tools uses).
 *
 * 1. Scans workspace sources very liberally: every quoted string anywhere in
 *    any text file (plus unquoted class=/className= attribute values) is
 *    split into whitespace-separated tokens and offered as candidates. This
 *    finds classes in template literals, variables, JSON, markdown, etc. —
 *    anywhere a class name can be written as a string.
 * 2. Feeds the extracted tokens to `compiler.build()` — the compiler itself
 *    parses each candidate and ignores anything invalid, so over-supplying
 *    is safe (a token that happens to look like a utility merely generates
 *    the same rule the CLI scanner would have generated).
 * 3. Stylesheets are resolved through `loadStylesheet`: the bundled
 *    tailwindcss/*.css (via Vite `?raw` imports), http(s) URLs, and
 *    workspace files.
 * 4. `@plugin`/`@config` modules are resolved through `loadModule`: the
 *    module (and its dependencies, from the workspace's node_modules) is
 *    bundled with the shared esbuild-wasm worker and imported from a blob
 *    URL — the same approach dataverse-dev-tools uses.
 */

import { compile } from 'tailwindcss'

import tailwindIndexCss from 'tailwindcss/index.css?raw'
import tailwindPreflightCss from 'tailwindcss/preflight.css?raw'
import tailwindThemeCss from 'tailwindcss/theme.css?raw'

import { EsbuildBuildRunner } from '../esbuild/buildRunner.js'
import { lazyBuild } from '../esbuild/lazyBuild.js'

import type * as vscodeType from 'vscode'

const SCANNABLE_EXTENSIONS =
  /\.(html|htm|vue|svelte|astro|xhtml|md|mdx|txt|ts|tsx|mts|cts|jsx|js|mjs|cjs|css|scss|less|sass|php|json|jsonc|yaml|yml|toml)$/i

/*
 * Any quoted string: '…', "…", `…` (template literals included; interpolated
 * ${…} parts are just tokens that get rejected by the compiler if invalid).
 */
const STRING_CAPTURE_PATTERN = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g

/* Unquoted attribute value: class=foo-bar / className={styles.foo} edge. */
const UNQUOTED_CLASS_PATTERN =
  /\bclass(?:Name)?\s*=\s*([^\s"'`>]+)/g

const DEFAULT_CSS_INPUT = '@import "tailwindcss";'

const MAX_SCANNED_FILES = 4000

/** Per-file cap so one giant file can't stall the scan. */
const MAX_TOKENS_PER_FILE = 20000

/** Candidates are short; anything longer is noise (URLs, base64, …). */
const MAX_CANDIDATE_LENGTH = 256

const CANDIDATE_SHAPE = /^[a-zA-Z0-9_![\]().,#%$@&*:+-]+$/

const BUNDLED_STYLESHEETS: Record<string, string> = {
  'tailwindcss': tailwindIndexCss,
  'tailwindcss/index.css': tailwindIndexCss,
  'tailwindcss/preflight.css': tailwindPreflightCss,
  'tailwindcss/preflight': tailwindPreflightCss,
  'tailwindcss/theme.css': tailwindThemeCss,
  'tailwindcss/theme': tailwindThemeCss,
  'tailwindcss/utilities.css': '@tailwind utilities;',
  'tailwindcss/utilities': '@tailwind utilities;',
}

export type TailwindCompileResult = {
  css: string
  /** Signature of (input css + candidate set) for change detection. */
  signature: string
  candidateCount: number
}

/*
 * Scan cache: unchanged files (same mtime) reuse the candidates extracted
 * last time, so watch rebuilds don't re-read and re-parse the whole
 * workspace on every save.
 */
const scanCache = new Map<
  string,
  { mtime: number; candidates: string[] }
>()

function extractCandidates(text: string): string[] {
  const candidates: string[] = []

  const addToken = (raw: string): void => {
    if (candidates.length >= MAX_TOKENS_PER_FILE) {
      return
    }

    /*
     * Trim punctuation stuck to the token by surrounding syntax (quotes,
     * commas, semicolons, braces, stray colons) without touching anything a
     * candidate can legitimately end with ([, ], dots, slashes, …).
     */
    const candidate = raw
      .replace(/^[\s"'`,;:(){}<>=]+/, '')
      .replace(/[\s"'`,;:(){}<>=]+$/, '')

    if (
      candidate.length === 0 ||
      candidate.length > MAX_CANDIDATE_LENGTH ||
      !CANDIDATE_SHAPE.test(candidate) ||
      !/[a-zA-Z]/.test(candidate) ||
      candidate.startsWith('$')
    ) {
      return
    }

    candidates.push(candidate)
  }

  for (const pattern of [STRING_CAPTURE_PATTERN, UNQUOTED_CLASS_PATTERN]) {
    pattern.lastIndex = 0

    let match: RegExpExecArray | null

    while ((match = pattern.exec(text)) != null) {
      for (const token of match[2]?.split(/\s+/) ?? match[1].split(/\s+/)) {
        addToken(token)
      }
    }
  }

  return candidates
}

async function scanWorkspaceCandidates(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<Set<string>> {
  const uris = await vscode.workspace.findFiles(
    '**/*',
    '{**/node_modules/**,**/.git/**,**/.ide-build/**,**/dist/**,**/out/**}',
    MAX_SCANNED_FILES,
  )

  const candidates = new Set<string>()

  for (const uri of uris) {
    if (!SCANNABLE_EXTENSIONS.test(uri.path)) {
      continue
    }

    let mtime: number

    try {
      mtime = (await vscode.workspace.fs.stat(uri)).mtime
    } catch {
      // unreadable file: skip
      continue
    }

    const cached = scanCache.get(uri.path)

    if (cached != null && cached.mtime === mtime) {
      for (const candidate of cached.candidates) {
        candidates.add(candidate)
      }

      continue
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri)
      const text = new TextDecoder().decode(bytes)

      const extracted = extractCandidates(text)

      scanCache.set(uri.path, { mtime, candidates: extracted })

      for (const candidate of extracted) {
        candidates.add(candidate)
      }
    } catch {
      // unreadable/binary file: skip
    }
  }

  return candidates
}

function normalizeBase(base: string): string {
  return (base || '/').replaceAll('\\', '/')
}

function joinWorkspacePath(base: string, id: string): string {
  const cleanBase = normalizeBase(base).replace(/^\/+/, '').replace(/\/+$/, '')
  const cleanId = id.replaceAll('\\', '/').replace(/^\.\/+/, '')

  if (cleanBase.length === 0) {
    return cleanId
  }

  if (cleanId.startsWith('/')) {
    return cleanId.replace(/^\/+/, '')
  }

  return `${cleanBase}/${cleanId}`
}

/*
 * Stylesheet resolver handed to compile(). Covers the package's own css
 * (bundled at build time via ?raw), remote css, and workspace-relative css.
 */
function createLoadStylesheet(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
) {
  return async (
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; content: string }> => {
    const bundled = BUNDLED_STYLESHEETS[id]

    if (bundled != null) {
      return {
        path: `virtual:tailwindcss/${id}`,
        base: '/',
        content: bundled,
      }
    }

    if (id.startsWith('http://') || id.startsWith('https://')) {
      const response = await fetch(id)

      if (!response.ok) {
        throw new Error(`Failed to fetch stylesheet: ${id}`)
      }

      return { path: id, base, content: await response.text() }
    }

    const path = joinWorkspacePath(base, id)

    let content: string

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(rootUri, path),
      )

      content = new TextDecoder().decode(bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      throw new Error(`Could not load stylesheet "${id}" (${path}): ${message}`)
    }

    return {
      path,
      base: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/',
      content,
    }
  }
}

/*
 * Plugin module bundling.
 *
 * `@plugin` specifiers are loaded by bundling the module (and its imports,
 * resolved from the workspace's node_modules in the virtual file map) with
 * the shared esbuild-wasm worker, then importing the bundle from a blob URL.
 * Bundles are rebuilt on each compile (plugin edits reach watch mode), and
 * the collected file map is cached per compile.
 */

const MODULE_SOURCE_EXTENSIONS =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i

const MAX_MODULE_FILES = 8000
const MAX_MODULE_NODE_MODULES_FILES = 12000

const MODULE_EXCLUDE_PATTERN =
  '{**/.git/**,**/.ide-build/**,**/dist/**,**/out/**,**/node_modules/**}'

/*
 * node_modules must NOT exclude dist/ and out/: npm packages ship their
 * compiled entry points in those directories. Excluding them there left
 * only package.json/README in the collected map and made packages such as
 * valibot unresolvable.
 */
const MODULE_NODE_MODULES_EXCLUDE_PATTERN = '{**/.git/**,**/.ide-build/**}'

/** Entry file appended to the file map for bare `@plugin "pkg"` specifiers. */
const VIRTUAL_PLUGIN_ENTRY = '__tailwind-plugin-entry__.mjs'

async function collectModuleSources(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<Record<string, string>> {
  const rootPath = rootUri.path.replace(/\/+$/, '')

  const collect = async (
    pattern: string,
    exclude: string,
    cap: number,
  ): Promise<vscodeType.Uri[]> => vscode.workspace.findFiles(pattern, exclude, cap)

  const [sourceUris, nodeModulesUris] = await Promise.all([
    collect('**/*', MODULE_EXCLUDE_PATTERN, MAX_MODULE_FILES),
    collect('node_modules/**', MODULE_NODE_MODULES_EXCLUDE_PATTERN, MAX_MODULE_NODE_MODULES_FILES),
  ])

  const files: Record<string, string> = {}

  for (const uri of [...sourceUris, ...nodeModulesUris]) {
    if (!MODULE_SOURCE_EXTENSIONS.test(uri.path)) {
      continue
    }

    const relativePath = uri.path
      .slice(rootPath.length)
      .replace(/^\//, '')
      .replaceAll('\\', '/')

    if (relativePath.length === 0) {
      continue
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri)

      files[relativePath] = new TextDecoder().decode(bytes)
    } catch {
      // unreadable/binary file: skip
    }
  }

  return files
}

/**
 * Bundle a module through the esbuild worker and import it.
 *
 * Bare specifiers go through a virtual entry (`import "pkg"`), so the
 * worker's own package resolution (exports maps, browser conditions,
 * subpaths) resolves them against the collected node_modules file map.
 * Unresolved bare imports are left external by the worker — which would
 * break the blob import — so they are reported as an error instead.
 *
 * Uses the shared lazyBuild loop: the worker may answer with a probe
 * response (outputs: [], needFiles: [...]) when the collected map lacks
 * package files (e.g. overlay-FS workspaces where findFiles cannot see
 * node_modules); the loop reads the requested paths from the workspace
 * before finalizing. Without it, a probe round looks exactly like
 * "produced no output".
 */
async function bundleAndImportModule(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  runner: EsbuildBuildRunner,
  files: Record<string, string>,
  entry: string,
  outputChannel?: vscodeType.OutputChannel,
): Promise<{ module: unknown; text: string }> {
  const response = await lazyBuild(
    vscode,
    rootUri,
    runner,
    { entry, files, bundle: true, format: 'esm', minify: false, sourcemap: false },
  )

  if (!response.ok) {
    throw new Error(`Bundling tailwind module "${entry}" failed: ${response.error}`)
  }

  const bundle = response.outputs.find((output) => output.path.endsWith('.js'))

  if (bundle == null) {
    throw new Error(`Bundling tailwind module "${entry}" produced no output.`)
  }

  for (const warning of response.warnings) {
    if (warning.includes('left external')) {
      throw new Error(
        `Tailwind module "${entry}" imports packages that are not installed in the workspace: ${warning}`,
      )
    }
  }

  const blobUrl = URL.createObjectURL(
    new Blob([bundle.text], { type: 'text/javascript' }),
  )

  try {
    const module = await import(blobUrl).catch((error: unknown) => {
      throw new Error(
        `Importing the bundled tailwind module "${entry}" failed: ` +
          (error instanceof Error ? error.message : String(error)) +
          `. Bundle head: ${bundle.text.slice(0, 400)}`,
      )
    })

    return { module, text: bundle.text }
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/*
 * Module resolver handed to compile() for `@plugin` (and `@config`)
 * specifiers. Bare specifiers resolve against the workspace's own
 * node_modules (the package's browser/import exports, same resolution the
 * esbuild extension uses). http(s) modules import directly.
 */
type TailwindLoadModule = NonNullable<
  NonNullable<Parameters<typeof compile>[1]>['loadModule']
>

type TailwindModule = Awaited<ReturnType<TailwindLoadModule>>['module']

function createLoadModule(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  runner: EsbuildBuildRunner | undefined,
  pluginInputs: string[],
  outputChannel?: vscodeType.OutputChannel,
): TailwindLoadModule {
  /*
   * The file map is collected lazily on the first plugin load and reused
   * within one compile; bundles are rebuilt on every compile so plugin
   * edits show up in watch mode (their text feeds the build signature).
   */
  let filesPromise: Promise<Record<string, string>> | undefined

  const ensureFiles = (): Promise<Record<string, string>> => {
    filesPromise ??= collectModuleSources(vscode, rootUri)

    return filesPromise
  }

  return async (
    id: string,
    base: string,
  ): Promise<{ path: string; base: string; module: TailwindModule }> => {
    if (id.startsWith('http://') || id.startsWith('https://')) {
      const module = await import(/* @vite-ignore */ id)

      return { path: id, base, module: module.default ?? module }
    }

    if (runner == null) {
      throw new Error(
        `Cannot load @plugin "${id}": the esbuild plugin runner is unavailable.`,
      )
    }

    const cacheKey = `${id}\u0000${base}`

    const bundled = await (async (): Promise<{
      module: unknown
      text: string
    }> => {
      const files = await ensureFiles()

      if (!id.startsWith('.') && !id.startsWith('/')) {
        /*
         * Bare specifier ("pkg", "pkg/subpath", "@scope/pkg"): route it
         * through a virtual entry so the worker's package resolver
         * (exports maps, browser conditions, subpaths) locates it in the
         * collected node_modules.
         */
        const escaped = id.replaceAll('\\', '\\\\').replaceAll('"', '\\"')

        files[VIRTUAL_PLUGIN_ENTRY] = `import plugin from "${escaped}";\nexport default plugin;\n`

        return bundleAndImportModule(
          vscode,
          rootUri,
          runner,
          files,
          VIRTUAL_PLUGIN_ENTRY,
          outputChannel,
        )
      }

      return bundleAndImportModule(
        vscode,
        rootUri,
        runner,
        files,
        joinWorkspacePath(base, id),
        outputChannel,
      )
    })()

    /*
     * The bundled text participates in the build signature, so editing a
     * plugin (or its bundled dependencies) invalidates the cached output.
     */
    pluginInputs.push(`${cacheKey}\u0000${bundled.text}`)

    /*
     * Interop, same as the http path: the blob import's namespace wraps the
     * plugin function in `default`. Handing the raw namespace to compile()
     * makes tailwind invoke an object and fail with minified errors like
     * "k is not a function".
     */
    const rawModule = bundled.module as { default?: unknown } | null

    const pluginModule =
      typeof rawModule === 'function'
        ? rawModule
        : (rawModule?.default ?? rawModule)

    return {
      path: id,
      base,
      module: pluginModule as TailwindModule,
    }
  }
}

export async function compileTailwindCss(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: {
    input?: string
    /** Shared esbuild runner used to bundle @plugin modules. */
    pluginRunner?: EsbuildBuildRunner
    /** Minify the compiled CSS through the esbuild worker. */
    minify?: boolean
    /** Output channel for lazy-resolution diagnostics. */
    outputChannel?: vscodeType.OutputChannel
  } = {},
): Promise<TailwindCompileResult> {
  const inputPath = options.input

  let cssInput = DEFAULT_CSS_INPUT
  let base = '/'

  if (inputPath != null) {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(rootUri, inputPath),
      )

      cssInput = new TextDecoder().decode(bytes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      throw new Error(
        `Could not read the tailwind input stylesheet "${inputPath}": ${message}. ` +
          'Create the file, or remove "input" from tailwind.config.json to use the default (@import "tailwindcss").',
      )
    }

    base = inputPath.includes('/')
      ? inputPath.slice(0, inputPath.lastIndexOf('/'))
      : '/'
  }

  const candidates = await scanWorkspaceCandidates(vscode, rootUri)

  const pluginInputs: string[] = []

  const compiler = await compile(cssInput, {
    base,
    loadStylesheet: createLoadStylesheet(vscode, rootUri),
    loadModule: createLoadModule(
      vscode,
      rootUri,
      options.pluginRunner,
      pluginInputs,
      options.outputChannel,
    ),
  })

  const css = compiler.build([...candidates])

  let finalCss = css

  if (options.minify === true) {
    if (options.pluginRunner == null) {
      throw new Error(
        'Cannot minify: the esbuild plugin runner is unavailable.',
      )
    }

    const response = await options.pluginRunner.transform({
      filename: 'tailwind.css',
      source: css,
      minify: true,
    })

    if (!response.ok) {
      throw new Error(`CSS minification failed: ${response.error}`)
    }

    const minified = response.outputs[0]?.text

    if (minified == null) {
      throw new Error('CSS minification produced no output.')
    }

    finalCss = minified
  }

  const signature = [
    cssInput,
    ...pluginInputs,
    [...candidates].sort().join('\u0001'),
  ].join('\u0000')

  return {
    css: finalCss,
    signature,
    candidateCount: candidates.size,
  }
}
