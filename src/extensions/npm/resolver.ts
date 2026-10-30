/*
 * Dependency tree resolver for the npm extension.
 *
 * almostnode's built-in `resolveDependencies` fails on partial ranges such as
 * `seroval@^1.0` (its `satisfies` requires a full x.y.z core). This module is
 * a drop-in replacement for that resolution step, delegating semver range
 * matching to the `semver` package and reusing almostnode's `Registry` for
 * fetching/caching manifests. The resolved map is handed to almostnode's
 * PackageManager for downloading and extracting tarballs.
 */

import type { npm } from 'almostnode'
import { maxSatisfying } from 'semver'

/*
 * Semver range matching delegates to the `semver` npm package (the same
 * implementation npm's own tooling uses), which handles partial ranges,
 * prerelease ordering, x-ranges, and operator desugaring per spec.
 */

type RegistryType = npm.Registry
type PackageManifestType = npm.PackageManifest
type ResolvedPackageType = npm.ResolvedPackage

export type ResolveTreeOptions = {
  onProgress?: (message: string) => void
  includeOptional?: boolean
}

type IdempotencyContext = {
  registry: RegistryType
  resolved: Map<string, ResolvedPackageType>
  resolving: Set<string>
  options: ResolveTreeOptions
}

/*
 * Resolve a package and its full dependency closure (flat node_modules: one
 * version per package name). The shape matches almostnode's own resolver so
 * PackageManager internals can consume the result unchanged.
 */
export async function resolveTree(
  packageName: string,
  versionRange = 'latest',
  registry: RegistryType,
  options: ResolveTreeOptions = {},
  // Optionally continue resolving into (and reusing versions from) an
  // existing map, e.g. when resolving all package.json roots together.
  shared?: Map<string, ResolvedPackageType>,
): Promise<Map<string, ResolvedPackageType>> {
  const context: IdempotencyContext = {
    registry,
    resolved: shared ?? new Map(),
    resolving: new Set(),
    options,
  }

  await resolvePackage(packageName, versionRange, context)

  return context.resolved
}

async function resolvePackage(
  packageName: string,
  versionRange: string,
  context: IdempotencyContext,
): Promise<void> {
  const { registry, resolved, resolving, options } = context

  const key = `${packageName}@${versionRange}`

  // Circular dependency guard.
  if (resolving.has(key)) {
    return
  }

  // Already resolved: keep the existing version (flat node_modules).
  if (resolved.has(packageName)) {
    return
  }

  resolving.add(key)

  try {
    options.onProgress?.(`Resolving ${packageName}@${versionRange}`)

    const manifest = await registry.getPackageManifest(packageName)

    const targetVersion = pickVersion(manifest, versionRange)

    if (targetVersion == null) {
      throw new Error(
        `No matching version found for ${packageName}@${versionRange}`,
      )
    }

    const versionData = manifest.versions[targetVersion]

    const resolvedPackage: ResolvedPackageType = {
      name: packageName,
      version: targetVersion,
      tarballUrl: versionData.dist.tarball,
      dependencies: versionData.dependencies ?? {},
    }

    resolved.set(packageName, resolvedPackage)

    /*
     * Non-optional peerDependencies install like regular dependencies (npm
     * v7+ behaviour), then regular dependencies override them.
     */
    const incomingDeps: Record<string, string> = {}

    if (versionData.peerDependencies != null) {
      const peerMeta = versionData.peerDependenciesMeta ?? {}

      for (const [peerName, peerRange] of Object.entries(
        versionData.peerDependencies,
      )) {
        if (!peerMeta[peerName]?.optional) {
          incomingDeps[peerName] = peerRange
        }
      }
    }

    Object.assign(incomingDeps, versionData.dependencies ?? {})

    if (options.includeOptional && versionData.optionalDependencies != null) {
      Object.assign(incomingDeps, versionData.optionalDependencies)
    }

    // Guard against malformed dependency entries.
    const depEntries = Object.entries(incomingDeps).filter(
      ([depName, depRange]) =>
        depName.length > 0 && typeof depRange === 'string' && depRange.length > 0,
    )

    const CONCURRENCY = 8

    for (let index = 0; index < depEntries.length; index += CONCURRENCY) {
      const batch = depEntries.slice(index, index + CONCURRENCY)

      await Promise.all(
        batch.map(([depName, depRange]) =>
          resolvePackage(depName, depRange, context),
        ),
      )
    }
  } finally {
    resolving.delete(key)
  }
}

function pickVersion(
  manifest: PackageManifestType,
  versionRange: string,
): string | null {
  // Exact or dist-tag range.
  if (manifest.versions[versionRange] != null) {
    return versionRange
  }

  if (manifest['dist-tags']?.[versionRange] != null) {
    return manifest['dist-tags'][versionRange]
  }

  if (versionRange === 'latest' || versionRange === '*') {
    return manifest['dist-tags']?.latest ?? null
  }

  return maxSatisfying(Object.keys(manifest.versions), versionRange)
}
