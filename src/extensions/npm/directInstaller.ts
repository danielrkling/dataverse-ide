/*
 * Direct npm installer: no VirtualFS.
 *
 * Flow (all reads/writes hit the real workspace filesystem):
 *   1. ensure a package.json exists in the workspace root
 *   2. resolve the requested specs' full dependency closure against the
 *      real registry via resolveTree (semver-based, see ./resolver.ts)
 *   3. download each tarball, gunzip + untar (./tarball.ts), and write the
 *      files straight into workspace node_modules via vscode.workspace.fs
 *   4. write node_modules/.package-lock.json with resolved versions
 *   5. save the requested roots as ^range in the target package.json section
 *
 * Replaces the earlier load-into-VFS → install-in-VFS → copy-back flow.
 */

import type * as vscodeType from 'vscode'
import { npm } from 'almostnode'

import { ensureWorkspacePackageJson, writeWorkspaceFileText } from './packageBridge'
import { resolveTree } from './resolver'
import { gunzip, parseTar } from './tarball'

const CONCURRENCY = 6

export type NpmDependencySection = 'dependencies' | 'devDependencies'

type ResolvedPackageValue = npm.ResolvedPackage

export type ResolvedMap = Map<string, ResolvedPackageValue>

export type DirectInstallOptions = {
  /** Explicit specs to install, e.g. "lodash" / "@solidjs/web@2.0.0-rc.19". */
  specs?: string[]
  /** Install everything currently declared in package.json. */
  allDependencies?: boolean
  /** Include devDependencies when allDependencies is set. */
  includeDev?: boolean
  /** Whether to add the roots to package.json (specs mode only). */
  save?: boolean
  onProgress: (message: string) => void
}

export type DirectInstallResult = {
  /** Packages that were actually downloaded/written (new or upgraded). */
  installed: string[]
  /** All roots considered, resolved to concrete versions. */
  resolved: ResolvedMap
}

export async function directInstall(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: DirectInstallOptions,
  section: NpmDependencySection = 'dependencies',
): Promise<DirectInstallResult> {
  const { onProgress } = options

  const packageJsonText = await ensureWorkspacePackageJson(vscode, rootUri)

  if (packageJsonText == null) {
    throw new Error(
      'The workspace has no package.json and none could be created.',
    )
  }

  const packageJson = JSON.parse(packageJsonText) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const registry = new npm.Registry()

  const roots = collectRoots(packageJson, options)

  onProgress?.(
    `Resolving ${roots.length} root package${roots.length === 1 ? '' : 's'}...`,
  )

  const resolved: ResolvedMap = new Map()

  for (
    let index = 0;
    index < roots.length;
    index += CONCURRENCY
  ) {
    await Promise.all(
      roots
        .slice(index, index + CONCURRENCY)
        .map(([name, range]) =>
          resolveTree(name, range, registry, { onProgress }, resolved),
        ),
    )
  }

  /*
   * Skip packages already present at the exact resolved version.
   */
  const toInstall: ResolvedPackageValue[] = []

  for (const pkg of resolved.values()) {
    const installed = await readInstalledVersion(vscode, rootUri, pkg.name)

    if (installed === pkg.version) {
      onProgress?.(`Skipping ${pkg.name}@${pkg.version} (already installed)`)
      continue
    }

    onProgress?.(`Extracting ${pkg.name}@${pkg.version}...`)
    toInstall.push(pkg)
  }

  for (
    let index = 0;
    index < toInstall.length;
    index += CONCURRENCY
  ) {
    await Promise.all(
      toInstall
        .slice(index, index + CONCURRENCY)
        .map(async (pkg) => {
          await extractTarballToWorkspace(
            vscode,
            rootUri,
            pkg.tarballUrl,
            packageNodeSegments(pkg.name),
          )

          onProgress?.(`Installed ${pkg.name}@${pkg.version}`)
        }),
    )
  }

  await writeLockfile(vscode, rootUri, resolved, onProgress)

  if (options.save !== false && options.specs != null) {
    await saveRootsToPackageJson(
      vscode,
      rootUri,
      packageJson,
      roots.map(([name]) => name),
      resolved,
      section,
    )
  }

  return {
    installed: toInstall.map((pkg) => pkg.name),
    resolved,
  }
}

function collectRoots(
  packageJson: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  },
  options: DirectInstallOptions,
): Array<[string, string]> {
  if (options.specs != null && options.specs.length > 0) {
    return options.specs.map((spec) => parseSpecToRoot(spec))
  }

  const roots: Array<[string, string]> = Object.entries(
    packageJson.dependencies ?? {},
  )

  if (options.includeDev === true) {
    roots.push(...Object.entries(packageJson.devDependencies ?? {}))
  }

  return roots.filter(([name, range]) => name.length > 0 && range.length > 0)
}

function parseSpecToRoot(spec: string): [string, string] {
  const { name, version } = npm.parsePackageSpec(spec)

  return [name, version == null || version.length === 0 ? 'latest' : version]
}

export function packageNodeSegments(packageName: string): string[] {
  return ['node_modules', ...packageName.split('/')]
}

async function readInstalledVersion(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  packageName: string,
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(rootUri, ...packageNodeSegments(packageName), 'package.json'),
    )

    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      version?: string
    }

    return parsed.version
  } catch {
    return undefined
  }
}

async function extractTarballToWorkspace(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  tarballUrl: string,
  nodeSegments: string[],
): Promise<number> {
  const response = await fetch(tarballUrl)

  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${tarballUrl.replace(/^.*\/(.+tgz)$/, '$1')} (${response.status})`)
  }

  const tarData = await gunzip(new Uint8Array(await response.arrayBuffer()))

  const dest = vscode.Uri.joinPath(rootUri, ...nodeSegments)

  let fileCount = 0

  for (const entry of parseTar(tarData)) {
    if (entry.type !== 'file' && entry.type !== 'directory') {
      // symlinks etc. are skipped, matching almostnode's extractor
      continue
    }

    const parts = entry.name
      .split('/')
      .filter((part) => part.length > 0 && part !== '.')

    // strip npm's leading "package/" directory
    if (parts.length <= 1) {
      continue
    }

    const relativeParts = parts.slice(1)

    if (relativeParts.some((part) => part === '..')) {
      // never write outside node_modules/<name>
      continue
    }

    if (entry.type === 'directory') {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(dest, ...relativeParts),
      )

      continue
    }

    const parentSegments = relativeParts.slice(0, -1)

    if (parentSegments.length > 0) {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(dest, ...parentSegments),
      )
    }

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dest, ...relativeParts),
      entry.content ?? new Uint8Array(0),
    )

    fileCount++
  }

  return fileCount
}

async function writeLockfile(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  resolved: ResolvedMap,
  onProgress: (message: string) => void,
): Promise<void> {
  if (!resolved.size) {
    return
  }

  const lockfile: Record<string, { version: string; resolved: string }> = {}

  for (const [name, pkg] of resolved) {
    lockfile[name] = {
      version: pkg.version,
      resolved: pkg.tarballUrl,
    }
  }

  await writeWorkspaceFileText(
    vscode,
    vscode.Uri.joinPath(rootUri, 'node_modules', '.package-lock.json'),
    `${JSON.stringify(lockfile, null, 2)}\n`,
  )

  onProgress?.('Wrote node_modules/.package-lock.json')
}

async function saveRootsToPackageJson(  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  packageJson: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  },
  rootNames: string[],
  resolved: ResolvedMap,
  section: NpmDependencySection,
): Promise<void> {
  let touched = false

  const destination =
    section === 'devDependencies'
      ? (packageJson.devDependencies ??= {})
      : (packageJson.dependencies ??= {})

  for (const name of rootNames) {
    const pkg = resolved.get(name)

    if (pkg == null) {
      continue
    }

    const range = `^${pkg.version}`

    if (packageJson.dependencies?.[name] !== range) {
      if (packageJson.devDependencies?.[name] === range) {
        // already saved in devDependencies: leave it there
        continue
      }

      destination[name] = range
      touched = true
    }
  }

  if (!touched) {
    return
  }

  await writeWorkspaceFileText(
    vscode,
    vscode.Uri.joinPath(rootUri, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  )
}
