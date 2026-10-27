/*
 * esbuild worker: runs the esbuild-wasm compiler off the main thread.
 *
 * Protocol (plain postMessage request/response):
 *   { id, type: 'build', entry, files, format? }
 *   <- { id, ok, outputs }             (success)
 *   <- { id, ok: false, error }        (failure)
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
  format?: 'esm' | 'iife'
}

type TransformRequest = {
  id: number
  type: 'transform'
  filename: string
  source: string
}

export type WorkerRequest = BuildRequest | TransformRequest

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

type BuildResponse = BuildSuccessResponse | BuildFailureResponse

let initialization: Promise<void> | undefined

async function ensureInitialized(): Promise<void> {
  if (initialization == null) {
    initialization = (async () => {
      const bytes = Uint8Array.from(atob(wasmBase64), (character) =>
        character.charCodeAt(0),
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
]

const INDEX_TRAILS = [
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/index.cjs',
]

/*
 * Extension candidates for package export targets (ESM-first mainly, unlike
 * source files where ts variants come first).
 */
const COMPANION_EXTENSIONS = [
  '',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.json',
]

function normalizePath(value: string): string {
  const segments: string[] = []

  for (const segment of value.split('/')) {
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

function getLoaderForPath(path: string): string {
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

/*
 * Node builtins cannot run in the browser and have no node_modules
 * counterpart: keep them externalized in the output.
 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

function parseJsonSafe(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/*
 * Split a bare specifier into package name and subpath.
 *   'lodash'            -> ['node_modules/lodash', '']
 *   'lodash/fp'         -> ['node_modules/lodash', 'fp']
 *   '@scope/pkg'        -> ['node_modules/@scope/pkg', '']
 *   '@scope/pkg/lib'    -> ['node_modules/@scope/pkg', 'lib']
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

    if (secondSlash === -1) {
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
 * Resolve an entries-like list against the file map, trimmed of query
 * markers: candidates are tried with common extensions and /index trails.
 */
function resolveExportTarget(
  target: string,
  lookup: (path: string) => string | undefined,
): string | undefined {
  const normalized = target.replaceAll('\\', '/').replace(/\/+$/, '')

  if (normalized.length === 0) {
    return undefined
  }

  return lookup(normalized)
}

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
    return subpath.length === 0
      ? resolveExportTarget(`${pkgDir}/${exportsField}`, lookup)
      : undefined
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

  const map = exportsField as Record<string, unknown>
  const keys = Object.keys(map)

  const preferredOrder = ['.', 'import', 'browser', 'module', 'default']

  keys.sort(
    (left, right) =>
      preferredOrder.indexOf(left) - preferredOrder.indexOf(right) ||
      left.length - right.length,
  )

    const normalizedSubpath = subpath.replace(/^\.\//, '')

  for (const key of keys) {
    const normalizedKey = key.replace(/^\.\//, '')

    if (
      normalizedKey === normalizedSubpath ||
      (normalizedSubpath.length === 0 && normalizedKey === '.')
    ) {
      return resolveExportsField(map[key], '', pkgDir, lookup)
    }
  }

  return undefined
}

function createPackageResolver(files: Record<string, string>) {
  function lookup(path: string): string | undefined {
    if (files[path] != null) {
      return path
    }

    for (const extension of COMPANION_EXTENSIONS) {
      const candidate = `${path}${extension}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${path}${trail}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    return undefined
  }

  function resolveBareImport(specifier: string): string | undefined {
    const { packageDir, subpath } = splitPackageSpec(specifier)

    const packageJson = parseJsonSafe(
      files[`${packageDir}/package.json`] ?? '',
    )

    if (packageJson != null) {
      const viaExports = resolveExportsField(
        packageJson.exports,
        subpath,
        packageDir,
        lookup,
      )

      if (viaExports != null) {
        return viaExports
      }

      if (subpath.length === 0) {
        for (const entryField of ['main', 'module', 'browser']) {
          const entry = packageJson[entryField]

          if (typeof entry === 'string' && entry.length > 0) {
            const resolved = resolveExportTarget(
              `${packageDir}/${entry}`,
              lookup,
            )

            if (resolved != null) {
              return resolved
            }
          }
        }
      }
    }

    /*
     * Without package.json (rare), try spec or spec/index directly.
     */
    const direct =
      subpath.length > 0
        ? lookup(`${packageDir}/${subpath}`)
        : lookup(packageDir)

    return direct
  }

  return { resolveBareImport }
}

function createVirtualFsPlugin(
  files: Record<string, string>,
): esbuild.Plugin {
  const fileNames = Object.keys(files)

  function lookup(path: string): string | undefined {
    if (files[path] != null) {
      return path
    }

    for (const extension of RESOLVABLE_EXTENSIONS) {
      const candidate = `${path}${extension}`

      if (files[candidate] != null) {
        return candidate
      }
    }

    for (const trail of INDEX_TRAILS) {
      const candidate = `${path}${trail}`

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

        if (args.path.startsWith('#')) {
          return undefined
        }

        if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
          if (
            NODE_BUILTINS.has(args.path) ||
            args.path.startsWith('node:')
          ) {
            return { path: args.path, external: true }
          }

          const resolved = packageResolver.resolveBareImport(
            normalizePath(args.path),
          )

          if (resolved != null) {
            return { path: resolved, namespace: 'virtual' }
          }

          /*
           * Unresolvable bare specifier: externalize so the output keeps a
           * standard import rather than failing the build.
           */
          return { path: args.path, external: true }
        }

        const importerDir = args.importer.normalize('NFC').includes('/')
          ? args.importer.split('/').slice(0, -1)
          : []

        const joined =
          args.path.startsWith('/')
            ? normalizePath(args.path)
            : normalizePath([...importerDir, args.path].join('/'))

        const resolved = lookup(joined)

        if (resolved != null) {
          return { path: resolved, namespace: 'virtual' }
        }

        /*
         * Fall back to trying a path outside the virtual fs namespace so
         * css @import handling etc. can still resolve.
         */
        return { path: args.path }
      })

      build.onLoad(
        { filter: /.*/, namespace: 'virtual' },
        (args) => {
          const contents = files[normalizePath(args.path)]

          if (contents == null) {
            const available = fileNames
              .slice(0, 12)
              .join(', ')

            return {
              errors: [
                {
                  text: `File not found in workspace: "${args.path}" (available: ${available}…).`,
                },
              ],
            }
          }

          return {
            contents,
            loader: getLoaderForPath(args.path) as esbuild.Loader,
          }
        },
      )
    },
  }
}

let requestCounter = 0

async function transform(
  request: TransformRequest,
): Promise<BuildResponse> {
  try {
    await ensureInitialized()

    const extension = request.filename.split('.').pop() ?? 'js'

    const loaderById: Record<string, string> = {
      ts: 'ts',
      mts: 'ts',
      cts: 'ts',
      tsx: 'tsx',
      jsx: 'jsx',
    }

    const result = await esbuild.transform(request.source, {
      loader: (loaderById[extension] ?? (
        extension === 'css' ? 'css' : 'js'
      )) as esbuild.Loader,
      format: 'cjs',
      target: 'es2022',
      sourcemap: false,
      logLevel: 'silent',
    })

    return {
      id: request.id,
      ok: true,
      outputs: [
        {
          path: request.filename,
          text: result.code as string,
        },
      ],
      warnings: result.warnings.map((warning) => warning.text),
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function build(request: BuildRequest): Promise<BuildResponse> {
  try {
    await ensureInitialized()

    const result = await esbuild.build({
      entryPoints: [normalizePath(request.entry)],
      bundle: true,
      write: false,
      format: request.format ?? 'esm',
      target: 'es2022',
      sourcemap: false,
      logLevel: 'silent',
      plugins: [createVirtualFsPlugin(request.files)],
      outbase: '.',
      outdir: 'out',
    })

    return {
      id: request.id,
      ok: true,
      outputs: result.outputFiles
        .filter((file) => file.contents != null)
        .map((file) => ({
          path: file.path,
          text: file.text,
        })),
      warnings: result.warnings.map(
        (warning) => `${warning.text}${warning.location != null ? ` (${plural(warning.location)})` : ''}`,
      ),
    }
  } catch (error) {
    let message = 'Build failed.'

    if (typeof error === 'string') {
      /*
       * esbuild rejects with an array-joined string of build errors.
       */
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

function plural(location: { file?: string; line?: number; column?: number }): string {
  return `${location.file ?? ''}:${location.line ?? 0}:${location.column ?? 0}`
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const request = event.data

  if (request?.type == null || request.id == null) {
    return
  }

  const response =
    request.type === 'build' ? await build(request) : await transform(request)

  self.postMessage(response)
}
