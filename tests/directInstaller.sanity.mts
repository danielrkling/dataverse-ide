/*
 * End-to-end check of the direct installer without a VirtualFS: a fake
 * vscode.workspace.fs (in-memory) + Uri.joinPath shim, resolving and
 * extracting a real package from registry.npmjs.org.
 *
 * Run: node --experimental-strip-types tests/directInstaller.sanity.mts
 */
import { strict as assert } from 'node:assert'

import { gunzip, parseTar } from '../src/extensions/npm/tarball.ts'

// --- gunzip + parseTar on a real npm tarball -------------------------------

const tarballName = 'left-pad-1.3.0' as const

const response = await fetch(
  `https://registry.npmjs.org/left-pad/-/${tarballName}.tgz`,
)

assert.equal(response.ok, true, 'tarball download failed')

const compressed = new Uint8Array(await response.arrayBuffer())
const tar = await gunzip(compressed)

let files = 0
let packageJson: unknown

for (const entry of parseTar(tar)) {
  if (entry.type !== 'file') continue
  const parts = entry.name.split('/').filter((p) => p && p !== '.')
  if (parts.length <= 1) continue
  if (parts.slice(1).join('/') === 'package.json') {
    packageJson = JSON.parse(new TextDecoder().decode(entry.content))
  }
  files++
}

assert.ok(files > 0, 'no files extracted')
assert.equal(
  (packageJson as { name?: string }).name,
  'left-pad',
  'package.json entry not found/invalid',
)

console.log(`left-pad-1.3.0: extracted ${files} file entries, package.json ok`)

// --- fake workspace fs ------------------------------------------------------

type FakeFile = { content: Uint8Array }
const store = new Map<string, FakeFile>()

const uriJoin = (base: string, ...parts: string[]): string => {
  const cleaned = base.replace(/^(fake:\/*)/, '')

  return `fake:/${[cleaned, ...parts.join('/').split('/')]
    .filter((p) => p.length > 0)
    .join('/')}`
}

const fakeVscode = {
  workspace: {
    fs: {
      async readFile(uri: string): Promise<Uint8Array> {
        const file = store.get(uri)
        if (file == null) {
          const error = new Error('not found') as Error & { code?: string }
          error.code = 'FileNotFound'
          throw error
        }
        return file.content
      },
      async createDirectory(_uri: string): Promise<void> {
        store.set(_uri.replace(/\/[^/]+$/, ''), { content: new Uint8Array(0) })
      },
      async writeFile(uri: string, content: Uint8Array): Promise<void> {
        store.set(uri, { content })
      },
    },
  },
  Uri: {
    joinPath: (base: unknown, ...parts: string[]): string =>
      uriJoin(String(base), ...parts),
  },
  window: { showInformationMessage: async () => undefined },
} as unknown as typeof import('vscode')

import { directInstall } from '../src/extensions/npm/directInstaller.ts'

const result = await directInstall(
  fakeVscode,
  'fake:/root' as never,
  { specs: ['left-pad'], onProgress: (m) => console.log('  ' + m) },
)

assert.deepEqual(result.resolved.get('left-pad')?.version, '1.3.0')
assert.ok(store.size > 1, 'expected files written to fake workspace')

// package.json saved with ^range in dependencies
const savedPackageJson = JSON.parse(
  new TextDecoder().decode(store.get('fake:/root/package.json')!.content),
) as { dependencies?: Record<string, string> }
assert.equal(
  savedPackageJson.dependencies?.left-pad,
  '^1.3.0',
  'dependency not saved to package.json',
)

// lockfile written directly into workspace
const lock = JSON.parse(
  new TextDecoder().decode(
    store.get('fake:/root/node_modules/.package-lock.json')!.content,
  ),
) as Record<string, { version: string }>
assert.equal(lock.left-pad?.version, '1.3.0', 'lockfile missing left-pad')

// node_modules/left-pad/package.json exists
const installedPackageJson = JSON.parse(
  new TextDecoder().decode(
    store.get('fake:/root/node_modules/left-pad/package.json')!.content,
  ),
) as { version: string }
assert.equal(installedPackageJson.version, '1.3.0')

// re-run: everything already installed → zero downloads
const secondRun = await directInstall(
  fakeVscode,
  'fake:/root' as never,
  { specs: ['left-pad'], onProgress: (m) => {
      if (m.includes('Extracting')) {
        throw new Error('second run should skip extraction')
      }
    } },
)
assert.deepEqual(secondRun.installed, [])

console.log('directInstaller sanity passed —', store.size, 'fs entries')
process.exit(0)

