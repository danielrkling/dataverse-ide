/*
 * Live check: resolve the closure of @solidjs/web@latest with the own
 * resolver (the case that previously died on seroval@^1.0).
 */
import { Registry } from 'almostnode'

import { resolveTree } from '../src/extensions/npm/resolver.ts'

const registry = new Registry({})

const resolved = await resolveTree('@solidjs/web', 'latest', registry, {
  onProgress: (message) => console.log('  ' + message),
})

console.log(`resolved ${resolved.size} packages:`)

for (const [name, pkg] of resolved) {
  console.log(`  ${name}@${pkg.version}`)
}

const seroval = resolved.get('seroval')

if (seroval == null) {
  throw new Error('seroval was not resolved — regression')
}

console.log('OK — seroval resolved as', seroval.version)
