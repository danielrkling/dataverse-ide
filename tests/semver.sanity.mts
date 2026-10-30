/*
 * Regression guard for the semver behaviour the npm extension depends on.
 *
 * Range matching now delegates to the `semver` npm package, so this harness
 * pins the cases that motivated the delegation (partial ranges, prerelease
 * ordering/gating, operator desugaring). If a semver upgrade changes any of
 * them, this fails loudly before users do.
 *
 * Run: node --experimental-strip-types tests/semver.sanity.mts
 */
import { strict as assert } from 'node:assert'

import { satisfies, rsort, maxSatisfying } from 'semver'

// Partial ranges (almostnode's resolver rejected these outright).
assert.equal(satisfies('1.7.0', '^1.0'), true)
assert.equal(satisfies('2.0.0', '^1.0'), false)
assert.equal(satisfies('0.4.0', '^0.4'), true)
assert.equal(satisfies('0.0.4', '^0.4'), false)
assert.equal(satisfies('0.2.9', '^0.4'), false)
assert.equal(satisfies('1.2.3', '^1.2'), true)
assert.equal(satisfies('0.15.0', '^0.15.0'), true)
assert.equal(satisfies('0.16.0', '^0.15.0'), false)

// Tilde / comparators / compound ranges.
assert.equal(satisfies('1.5.2', '~1.5.2'), true)
assert.equal(satisfies('1.5.0', '~1.5.2'), false)
assert.equal(satisfies('1.6.0', '~1.5.2'), false)
assert.equal(satisfies('1.5.8', '>=1.5.2 <2.0.0'), true)
assert.equal(satisfies('1.5.0', '>=1.5.2 <2.0.0'), false)
assert.equal(satisfies('1.0.0', '>1'), false)
assert.equal(satisfies('2.0.0', '>1'), true)
assert.equal(satisfies('1.3.0', '>1.2'), true)
assert.equal(satisfies('1.5.0', '>1.2'), true)
assert.equal(satisfies('1.0.0', '<=1.2'), true)
assert.equal(satisfies('1.3.0', '<=1.2'), false)
assert.equal(satisfies('1.5.2', '>=1.5.2'), true)

// Hyphen ranges and `||`.
assert.equal(satisfies('2.0.0', '1.0.0 - 2.3.4'), true)
assert.equal(satisfies('2.4.0', '1.0.0 - 2.3'), false)
assert.equal(satisfies('2.5.0', '1.0.0 || ^2.0.0'), true)
assert.equal(satisfies('1.2.3', '1.0.0 || ^2.0.0'), false)

// Prerelease ordering and gating (the "matches 9" bug).
assert.equal(satisfies('2.0.0-rc.19', '2.0.0-rc.19'), true)
assert.equal(satisfies('2.0.0', '2.0.0-rc.19'), false)
assert.equal(satisfies('2.0.0-rc.19', '^2.0.0'), false)
assert.equal(satisfies('2.0.0-rc.19', '*'), false)
assert.equal(satisfies('1.9.2', '^2.0.0-rc.0'), false)

assert.deepEqual(
  rsort(['2.0.0-rc.0', '2.0.0-rc.19', '2.0.0-rc.9', '1.8.0']),
  ['2.0.0-rc.19', '2.0.0-rc.9', '2.0.0-rc.0', '1.8.0'],
)

// Best-match selection.
assert.equal(maxSatisfying(['1.0.0', '1.7.0', '2.0.0-rc.9'], '^1.0'), '1.7.0')
assert.equal(maxSatisfying(['1.7.0'], '2.0.0'), null)
// Release beats prerelease when both satisfy.
assert.equal(maxSatisfying(['2.0.0', '2.0.0-rc.19'], '*'), '2.0.0')

console.log('semver sanity tests passed')
