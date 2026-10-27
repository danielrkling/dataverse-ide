/*
 * esbuild worker: runs the esbuild-wasm compiler off the main thread.
 *
 * Protocol (plain postMessage request/response):
 *   { id, type: 'build', entry, files, format?, minify?, sourcemap?,
 *     target?, bundle?, external?, define?, entryNames? }
 *   <- { id, ok, outputs }             (success)
 *   <- { id, ok: false, error }        (failure)
 *
 * Workspace source files and text-based npm package files are provided by
 * the main thread as an in-memory virtual filesystem.
 */

/*
 * The wasm binary is embedded at build time through the
 * `virtual:esbuild-wasm-binary` module (vite.config.ts): Dataverse web
 * resources cannot host separate .wasm files. The binary is compiled with
 * `new WebAssembly.Module()` synchronously - legal in a worker - and handed
 * to esbuild-wasm through its `wasmModule` option.
 */
import * as esbuild from 'esbuild-wasm'
import wasmBase64 from 'virtual:esbuild-wasm-binary'

type BuildRequest = {
  id: number
  type: 'build'
  entry: string
  files: Record<string, string>
  format?: 'esm' | 'iife' | 'cjs'
  minify?: boolean
  sourcemap?: boolean
  target?: string

  /*
   * Bundle module graph (default true); false means transpile-only.
   */
  bundle?: boolean

  /*
   * Bare import paths intentionally left in output.
   *
   * Example:
   *   ["react", "@dataverse/web-api"]
   */
  external?: string[]

  /*
   * Build-time constants.
   *
   * Example:
   *   { "process.env.NODE_ENV": "\"production\"" }
   */
  define?: Record<string, string>

  /*
   * Entry-relative or workspace-relative pattern such as "[dir]/[name]".
   */
  entryNames?: string
}

type TransformRequest = {
  id: number
  type: 'transform'
  filename: string
  source: string
}

export type WorkerRequest =
  | BuildRequest
  | TransformRequest

export type BuildOutputFile = {
  path: string
  text: string
}

type BuildSuccessResponse = {
  id: number
  ok: true
  outputs: BuildOutputFile[]
  warnings: string[]
}

type BuildFailureResponse = {
  id: number
  ok: false
  error: string
}

type BuildResponse =
  | BuildSuccessResponse
  | BuildFailureResponse

let initialization: Promise<void> | undefined

async function ensureInitialized(): Promise<void> {
  if (initialization == null) {
    initialization = (async () => {
      const bytes = Uint8Array.from(
        atob(wasmBase64),
        (character) => character.charCodeAt(0),
      )

      const wasmModule = new WebAssembly.Module(bytes)

      await esbuild.initialize({
        wasmModule,
        worker: false,
      })
    })()
  }

  await initialization
}

/*
 * Source-file resolution order for relative workspace imports.
 */
const RESOLVABLE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
]

const INDEX_TRAILS = [
  '/index.ts',
  '/index.tsx',
  '/index.mts',
  '/index.cts',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
  '/index.css',
  '/index.json',
]

/*
 * Package resolution order. ESM files come before CommonJS files because
 * browser bundles should prefer package ESM builds when available.
 */
const COMPANION_EXTENSIONS = [
  '',
  '.mjs',
  '.js',
  '.jsx',
  '.cjs',
  '.ts',
  '.tsx',
  '.css',
  '.json',
]

/*
 * Node builtins have no browser implementation in this extension. Leave
 * them external so a user can provide a browser-compatible shim, or so the
 * final output visibly identifies that it cannot run standalone in-browser.
 */
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

function normalizePath(value: string): string {
  const segments: string[] = []

  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue
    }

    if (segment === '..') {
      segments.pop()
      continue
    }

    segments.push(segment)
  }

  return segments.join('/')
}

function getLoaderForPath(path: string): esbuild.Loader {
  if (path.endsWith('.css')) {
    return 'css'
  }

  if (path.endsWith('.json')) {
    return 'json'
  }

  if (
    path.endsWith('.ts') ||
    path.endsWith('.mts') ||
    path.endsWith('.cts')
  ) {
    return 'ts'
  }

  if (path.endsWith('.tsx')) {
    return 'tsx'
  }

  if (path.endsWith('.jsx')) {
    return 'jsx'
  }

  return 'js'
}

function parseJsonSafe(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown

    if (
      typeof parsed !== 'object' ||
      parsed == null ||
      Array.isArray(parsed)
    ) {
      return undefined
    }

    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/*
 * Split a bare import into its node_modules package directory and any
 * package subpath.
 *
 * Examples:
 *
 *   lodash                 -> node_modules/lodash, ""
 *   lodash/fp              -> node_modules/lodash, "fp"
 *   @scope/pkg             -> node_modules/@scope/pkg, ""
 *   @scope/pkg/subpath     -> node_modules/@scope/pkg, "subpath"
 */
function splitPackageSpec(specifier: string): {
  packageDir: string
  subpath: string
} {
  let packageName: string
  let subpath: string

  if (specifier.startsWith('@')) {
    const firstSlash = specifier.indexOf('/')
    const secondSlash = specifier.indexOf('/', firstSlash + 1)

    if (firstSlash === -1 || secondSlash === -1) {
      packageName = specifier
      subpath = ''
    } else {
      packageName = specifier.slice(0, secondSlash)
      subpath = specifier.slice(secondSlash + 1)
    }
  } else {
    const firstSlash = specifier.indexOf('/')

    if (firstSlash === -1) {
      packageName = specifier
      subpath = ''
    } else {
      packageName = specifier.slice(0, firstSlash)
      subpath = specifier.slice(firstSlash + 1)
    }
  }

  return {
    packageDir: `node_modules/${packageName}`,
    subpath,
  }
}

/*
 * Resolve a package target such as:
 *
 *   "./dist/index.js"
 *
 * against:
 *
 *   "node_modules/example-package"
 *
 * The normalizePath() call is essential. Without it, targets containing "./"
 * become paths such as:
 *
 *   node_modules/example-package/./dist/index.js
 *
 * which do not match the normalized paths used as keys in the file map.
 */
function resolveExportTarget(
  target: string,
  lookup: (path: string) => string | undefined,
): string | undefined {
  const normalized = normalizePath(
    target
      .replaceAll('\\', '/')
      .replace(/\/+$/, ''),
  )

  if (normalized.length === 0) {
    return undefined
  }

  return lookup(normalized)
}

/*
 * Resolve package.json "exports".
 *
 * Supports common modern package structures:
 *
 * Root string:
 *   "exports": "./dist/index.js"
 *
 * Conditional root export:
 *   "exports": {
 *     ".": {
 *       "browser": "./dist/browser.js",
 *       "import": "./dist/index.mjs",
 *       "default": "./dist/index.js"
 *     }
 *   }
 *
 * Subpath export:
 *   "exports": {
 *     "./plugin": "./dist/plugin.js"
 *   }
 *
 * Wildcard subpath export:
 *   "exports": {
 *     "./features/*": "./dist/features/*.js"
 *   }
 */
function resolveExportsField(
  exportsField: unknown,
  subpath: string,
  pkgDir: string,
  lookup: (path: string) => string | undefined,
): string | undefined {
  if (exportsField == null) {
    return undefined
  }

  if (typeof exportsField === 'string') {
    /*
     * A direct string exports only the package root. It does not expose
     * arbitrary package subpaths.
     */
    if (subpath.length > 0) {
      return undefined
    }

    return resolveExportTarget(
      `${pkgDir}/${exportsField}`,
      lookup,
    )
  }

  if (Array.isArray(exportsField)) {
    for (const candidate of exportsField) {
      const resolved = resolveExportsField(
        candidate,
        subpath,
        pkgDir,
        lookup,
      )

      if (resolved != null) {
        return resolved
      }
    }

    return undefined
  }

  if (
    typeof exportsField !== 'object' ||
    Array.isArray(exportsField)
  ) {
    return undefined
  }

  const map = exportsField as Record<string, unknown>

  const requestedSubpath =
    subpath.length === 0
      ? '.'
      : `./${subpath.replace(/^\.\//, '')}`

  /*
   * A map with "." or "./…" keys is a package subpath map. A map without
   * those keys is normally a conditional export map.
   */
  const hasSubpathEntries = Object.keys(map).some(
    (key) => key === '.' || key.startsWith('./'),
  )

  if (hasSubpathEntries) {
    const directTarget = map[requestedSubpath]

    if (directTarget != null) {
      return resolveExportsField(
        directTarget,
        '',
        pkgDir,
        lookup,
      )
    }

    /*
     * Basic wildcard support:
     *
     *   "./locale/*": "./dist/locale/*.js"
     */
    for (const [pattern, target] of Object.entries(map)) {
      if (!pattern.includes('*')) {
        continue
      }

      const wildcardIndex = pattern.indexOf('*')
      const prefix = pattern.slice(0, wildcardIndex)
      const suffix = pattern.slice(wildcardIndex + 1)

      if (
        !requestedSubpath.startsWith(prefix) ||
        !requestedSubpath.endsWith(suffix)
      ) {
        continue
      }

      const wildcardValue = requestedSubpath.slice(
        prefix.length,
        requestedSubpath.length - suffix.length,
      )

      if (typeof target === 'string') {
        return resolveExportTarget(
          `${pkgDir}/${target.replaceAll('*', wildcardValue)}`,
          lookup,
        )
      }

      /*
       * Conditional wildcard targets are uncommon but valid. This recursive
       * call resolves a conditional target after replacing its wildcard in
       * any direct-string branch handled above.
       */
      if (
        typeof target === 'object' &&
        target != null &&
        !Array.isArray(target)
      ) {
        for (const conditionTarget of Object.values(target)) {
          if (typeof conditionTarget !== 'string') {
            continue
          }

          const resolved = resolveExportTarget(
            `${pkgDir}/${conditionTarget.replaceAll('*', wildcardValue)}`,
            lookup,
          )

          if (resolved != null) {
            return resolved
          }
        }
      }
    }

    return undefined
  }

  /*
   * Conditional export map.
   *
   * Prefer browser-compatible ESM output. "require" remains a final fallback
   * for packages that expose CommonJS only.
   */
  const conditions = [
    'browser',
    'import',
    'module',
    'default',
    'require',
  ]

  for (const condition of conditions) {
    const target = map[condition]

    if (target == null) {
      continue
    }

    const resolved = resolveExportsField(
      target,
      '',
      pkgDir,
      lookup,
    )

    if (resolved != null) {
      return resolved
    }
  }

  return undefined
}

function createPackageResolver(
  files: Record<string, string>,
) {
  function lookup(path: string): string | undefined {
    const normalized = normalizePath(path)

    if (files[normalized] != null) {
      return normalized
    }

    for (const extension of COMPANION_EXTENSIONS) {
      const candidate = `${normalized}${extension}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    return undefined
  }

  function resolveBareImport(
    specifier: string,
  ): string | undefined {
    const {
      packageDir,
      subpath,
    } = splitPackageSpec(specifier)

    const packageJson = parseJsonSafe(
      files[`${packageDir}/package.json`] ?? '',
    )

    if (packageJson != null) {
      /*
       * "exports" is authoritative when present. Do not attempt arbitrary
       * internal paths after an exports map rejects a requested subpath.
       */
      if (packageJson.exports != null) {
        const viaExports = resolveExportsField(
          packageJson.exports,
          subpath,
          packageDir,
          lookup,
        )

        if (viaExports != null) {
          return viaExports
        }

        return undefined
      }

      /*
       * For a package subpath without exports, try the requested file path.
       *
       * Example:
       *   import "lodash/fp"
       *   -> node_modules/lodash/fp.js
       *   -> node_modules/lodash/fp/index.js
       */
      if (subpath.length > 0) {
        return lookup(
          `${packageDir}/${subpath}`,
        )
      }

      /*
       * Browser bundling should favor browser/module entry points before
       * CommonJS main when the package has no exports map.
       */
      for (const entryField of [
        'browser',
        'module',
        'main',
      ]) {
        const entry = packageJson[entryField]

        if (typeof entry !== 'string' || entry.length === 0) {
          continue
        }

        const resolved = resolveExportTarget(
          `${packageDir}/${entry}`,
          lookup,
        )

        if (resolved != null) {
          return resolved
        }
      }
    }

    /*
     * Fallback for packages with no readable package.json.
     */
    return subpath.length > 0
      ? lookup(`${packageDir}/${subpath}`)
      : lookup(packageDir)
  }

  return {
    resolveBareImport,
  }
}

function createVirtualFsPlugin(
  files: Record<string, string>,
  unresolvedBareImports: Set<string>,
): esbuild.Plugin {
  const fileNames = Object.keys(files)

  function lookup(path: string): string | undefined {
    const normalized = normalizePath(path)

    if (files[normalized] != null) {
      return normalized
    }

    for (const extension of RESOLVABLE_EXTENSIONS) {
      const candidate = `${normalized}${extension}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${normalized}${trail}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    return undefined
  }

  return {
    name: 'dataverse-ide-virtual-fs',

    setup(build) {
      const packageResolver = createPackageResolver(files)

      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') {
          return {
            path: normalizePath(args.path),
            namespace: 'virtual',
          }
        }

        /*
         * Package-import aliases need package.json "imports" support, which
         * is not yet implemented in this browser resolver. Let esbuild decide
         * whether another plugin/setting can resolve them.
         */
        if (args.path.startsWith('#')) {
          return undefined
        }

        /*
         * Bare imports: npm packages and Node builtins.
         */
        if (
          !args.path.startsWith('.') &&
          !args.path.startsWith('/')
        ) {
          if (
            NODE_BUILTINS.has(args.path) ||
            args.path.startsWith('node:')
          ) {
            return {
              path: args.path,
              external: true,
            }
          }

          const resolved = packageResolver.resolveBareImport(
            normalizePath(args.path),
          )

          if (resolved != null) {
            return {
              path: resolved,
              namespace: 'virtual',
            }
          }

          /*
           * Preserve the import rather than failing the entire build, but
           * report it in the build response so the user knows the output is
           * not fully bundled.
           */
          unresolvedBareImports.add(
            `${args.path} imported by ${args.importer || '<entry point>'}`,
          )

          return {
            path: args.path,
            external: true,
          }
        }

        /*
         * Relative and workspace-root-relative imports.
         */
        const importerDir = args.importer
          .normalize('NFC')
          .includes('/')
          ? args.importer.split('/').slice(0, -1)
          : []

        const joined = args.path.startsWith('/')
          ? normalizePath(args.path)
          : normalizePath(
            [...importerDir, args.path].join('/'),
          )

        const resolved = lookup(joined)

        if (resolved != null) {
          return {
            path: resolved,
            namespace: 'virtual',
          }
        }

        /*
         * Let esbuild continue resolution for paths the virtual filesystem
         * cannot satisfy. This preserves CSS import behavior where possible.
         */
        return {
          path: args.path,
        }
      })

      build.onLoad(
        {
          filter: /.*/,
          namespace: 'virtual',
        },
        (args) => {
          const normalizedPath = normalizePath(args.path)
          const contents = files[normalizedPath]

          if (contents == null) {
            const available = fileNames
              .slice(0, 12)
              .join(', ')

            return {
              errors: [
                {
                  text:
                    `File not found in workspace: "${normalizedPath}" ` +
                    `(available: ${available}…).`,
                },
              ],
            }
          }

          return {
            contents,
            loader: getLoaderForPath(normalizedPath),
          }
        },
      )
    },
  }
}

async function transform(
  request: TransformRequest,
): Promise<BuildResponse> {
  try {
    await ensureInitialized()

    const extension =
      request.filename
        .split('.')
        .at(-1)
        ?.toLowerCase() ?? 'js'

    const loaderByExtension: Record<string, esbuild.Loader> = {
      ts: 'ts',
      mts: 'ts',
      cts: 'ts',
      tsx: 'tsx',
      jsx: 'jsx',
      css: 'css',
      json: 'json',
    }

    const result = await esbuild.transform(
      request.source,
      {
        loader: loaderByExtension[extension] ?? 'js',
        format: 'cjs',
        target: 'es2022',
        sourcemap: false,
        logLevel: 'silent',
      },
    )

    return {
      id: request.id,
      ok: true,
      outputs: [
        {
          path: request.filename,
          text: result.code,
        },
      ],
      warnings: result.warnings.map(
        (warning) => warning.text,
      ),
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    }
  }
}

async function build(
  request: BuildRequest,
): Promise<BuildResponse> {
  try {
    await ensureInitialized()

    const unresolvedBareImports = new Set<string>()

    const result = await esbuild.build({
      entryPoints: [
        normalizePath(request.entry),
      ],
      bundle: request.bundle ?? true,
      write: false,
      format: request.format ?? 'esm',
      minify: request.minify ?? false,
      sourcemap: request.sourcemap ?? false,
      target: request.target ?? 'es2022',
      external: request.external,
      define: request.define,
      entryNames: request.entryNames,
      logLevel: 'silent',
      plugins: [
        createVirtualFsPlugin(
          request.files,
          unresolvedBareImports,
        ),
      ],
      outbase: '.',
      outdir: 'out',
    })

    const warnings = [
      ...result.warnings.map(
        (warning) =>
          `${warning.text}${warning.location != null
            ? ` (${formatLocation(warning.location)})`
            : ''
          }`,
      ),

      ...[...unresolvedBareImports]
        .sort()
        .map(
          (detail) =>
            `Could not resolve npm package "${detail}". ` +
            'It was left external in the output bundle.',
        ),
    ]

    return {
      id: request.id,
      ok: true,
      outputs: result.outputFiles
        .filter((file) => file.contents != null)
        .map((file) => ({
          path: file.path,
          text: file.text,
        })),
      warnings,
    }
  } catch (error) {
    let message = 'Build failed.'

    if (typeof error === 'string') {
      message = error
    } else if (error instanceof Error) {
      message = error.message
    }

    return {
      id: request.id,
      ok: false,
      error: message,
    }
  }
}

function formatLocation(
  location: {
    file?: string
    line?: number
    column?: number
  },
): string {
  return `${location.file ?? ''}:${location.line ?? 0}:${location.column ?? 0}`
}

self.onmessage = async (
  event: MessageEvent<WorkerRequest>,
): Promise<void> => {
  const request = event.data

  if (
    request == null ||
    request.type == null ||
    request.id == null
  ) {
    return
  }

  const response =
    request.type === 'build'
      ? await build(request)
      : await transform(request)

  self.postMessage(response)
}