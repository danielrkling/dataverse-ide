/*
 * Sanity check for listExtraneousPackages: everything required by a declared
 * dependency (directly or transitively) must be kept; truly extraneous
 * top-level packages and unparsable installs must be flagged for removal.
 *
 * Run: node --experimental-strip-types tests/prune.sanity.mts
 */
import { strict as assert } from 'node:assert'

import { listExtraneousPackages } from '../src/extensions/npm/packageBridge.ts'

const FILE_TYPE = { File: 1, Directory: 2 } as const

const files = new Map<string, Uint8Array>()
const directories = new Set<string>([
  'fake:/root',
  'fake:/root/node_modules',
  'fake:/root/node_modules/a',
  'fake:/root/node_modules/b',
  'fake:/root/node_modules/c',
  'fake:/root/node_modules/corrupt',
  'fake:/root/node_modules/peer',
])

const file = (path: string, record: unknown): void => {
  files.set(path, new TextEncoder().encode(JSON.stringify(record)))
}

file('fake:/root/package.json', { dependencies: { a: '^1.0.0' } })

// declares a direct dep, an (indirectly required) transitive dep, and a
// non-optional peer — all three must survive pruning.
file('fake:/root/node_modules/a/package.json', {
  version: '1.0.0',
  dependencies: { b: '^1.0.0' },
  peerDependencies: { peer: '^1.0.0' },
})
file('fake:/root/node_modules/b/package.json', { version: '1.0.0' })
file('fake:/root/node_modules/peer/package.json', { version: '1.0.0' })
// nothing declared requires c → extraneous
file('fake:/root/node_modules/c/package.json', { version: '9.9.9' })
// corrupt install: no package.json → flagged by npm-prune semantics

const childrenOf = (uri: string): Array<[string, number]> => {
  const prefix = uri.replace(/\/+$/, '') + '/'
  const children = new Map<string, number>()

  for (const dir of directories) {
    if (!dir.startsWith(prefix)) continue
    const relative = dir.slice(prefix.length)
    if (relative.length === 0 || relative.includes('/')) continue
    children.set(relative, FILE_TYPE.Directory)
  }

  for (const pathKey of files.keys()) {
    if (!pathKey.startsWith(prefix)) continue
    const relative = pathKey.slice(prefix.length)
    if (relative.includes('/')) continue
    children.set(relative, FILE_TYPE.File)
  }

  return [...children]
}

const fakeVscode = {
  FileType: FILE_TYPE,
  workspace: {
    fs: {
      async readFile(uri: string): Promise<Uint8Array> {
        const content = files.get(uri)

        if (content == null) {
          const error = new Error('not found') as Error & { code?: string }
          error.code = 'FileNotFound'
          throw error
        }

        return content
      },
      readDirectory: (uri: string): Promise<Array<[string, number]>> =>
        Promise.resolve(childrenOf(uri)),
    },
  },
  Uri: {
    joinPath: (base: unknown, ...parts: string[]): string => {
      const cleaned = String(base).replace(/^fake:+\/*/, '')

      return `fake:/${[cleaned, ...parts.join('/').split('/')].filter(Boolean).join('/')}`
    },
  },
} as unknown as typeof import('vscode')

const extraneous = (
  await listExtraneousPackages(fakeVscode, 'fake:/root' as never)
).map((entry) => entry.name)

assert.deepEqual(
  extraneous.sort(),
  ['c', 'corrupt'],
  `extraneous detection failed: got ${extraneous.join(', ')}`,
)

console.log('prune sanity passed — flagged for removal:', extraneous.join(', '))
process.exit(0)
