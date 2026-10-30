/*
 * Bridge between the workspace (via vscode.workspace.fs) and the npm registry.
 *
 * All metadata helpers read the real workspace package.json / node_modules
 * directly; installing does not use a VirtualFS at all (see
 * ./directInstaller.ts). package.json is consulted with ensureWorkspacePackageJson
 * so npm commands do not require the user to hand-write one first.
 */
import { rsort } from 'semver'

import type * as vscodeType from 'vscode'

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

async function readWorkspaceFileText(
  vscode: typeof vscodeType,
  fileUri: vscodeType.Uri,
): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(fileUri)

  return DECODER.decode(bytes)
}

export async function writeWorkspaceFileText(
  vscode: typeof vscodeType,
  fileUri: vscodeType.Uri,
  text: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(
    fileUri,
    ENCODER.encode(text),
  )
}

const MINIMAL_PACKAGE_JSON = {
  name: 'dataverse-ide-workspace',
  version: '0.1.0',
  private: true,
}

export async function ensureWorkspacePackageJson(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<string | undefined> {
  const packageJsonUri = vscode.Uri.joinPath(rootUri, 'package.json')

  try {
    return await readWorkspaceFileText(vscode, packageJsonUri)
  } catch (error) {
    /*
     * Create a starter package.json when none exists - npm commands should
     * not require the user to hand-write one first.
     */
    if (isFileNotFound(error)) {
      // fall through to creation
    } else {
      return undefined
    }
  }

  const created = `${JSON.stringify(MINIMAL_PACKAGE_JSON, null, 2)}\n`

  try {
    await writeWorkspaceFileText(vscode, packageJsonUri, created)

    /*
     * Do not await the notification/dialog here - an earlier version blocked
     * the install flow on this await, so the package the user asked to
     * install was never processed after the starter package.json was created.
     */
    void vscode.window
      .showInformationMessage(
        'npm: created a starter package.json in the workspace root.',
        'Open',
      )
      .then((createdInformation) => {
        if (createdInformation === 'Open') {
          void vscode.window.showTextDocument(packageJsonUri)
        }
      })

    return created
  } catch {
    return undefined
  }
}

function isFileNotFound(error: unknown): boolean {
  const code = (error as { code?: string | number } | undefined)?.code

  // vscode.FileSystemError instances carry the string code; monaco-vscode-api
  // internal provider errors may carry the numeric enum value 1 (FileNotFound).
  return code === 'FileNotFound' || code === 1
}









export type NpmDependencySection = 'dependencies' | 'devDependencies'

export type NpmDependency = {
  name: string
  range: string
  section: NpmDependencySection
}

export async function readWorkspaceDependencies(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<NpmDependency[]> {
  const packageJsonUri = vscode.Uri.joinPath(rootUri, 'package.json')

  let text: string

  try {
    text = await readWorkspaceFileText(vscode, packageJsonUri)
  } catch {
    return []
  }

  let parsed: {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const result: NpmDependency[] = []

  for (const section of ['dependencies', 'devDependencies'] as const) {
    const entries = parsed[section]

    if (entries == null) {
      continue
    }

    for (const name of Object.keys(entries)) {
      result.push({
        name,
        range: entries[name],
        section,
      })
    }
  }

  return result
}

const registryUrl = (packageName: string): string =>
  `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%2F', '%2f')}`

export async function fetchPackageVersions(
  packageName: string,
): Promise<string[]> {
  const response = await fetch(registryUrl(packageName), {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  })

  if (!response.ok) {
    throw new Error(
      `npm registry lookup for ${packageName} failed: ${response.status}`,
    )
  }

  const manifest = (await response.json()) as {
    versions?: Record<string, unknown>
    'dist-tags'?: Record<string, string>
  }

  const versions = Object.keys(manifest.versions ?? {})

  const latest = manifest['dist-tags']?.latest

  if (latest != null) {
    versions.splice(versions.indexOf(latest), 1)
    versions.unshift(latest)
  }

  /*
   * Reverse-sorted newest first via the `semver` package (proper prerelease
   * ordering). The previous in-place Number()-coercion sort mangled
   * prerelease identifiers (`2.0.0-rc.19` sorted via NaN comparisons and
   * could lose to `rc.9`).
   */
  return rsort(versions, { loose: true }).slice(0, 200)
}

export async function uninstallDependency(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  dependency: NpmDependency,
): Promise<void> {
  const packageJsonUri = vscode.Uri.joinPath(rootUri, 'package.json')

  const text = await readWorkspaceFileText(vscode, packageJsonUri)
  const parsed = JSON.parse(text) as Record<string, unknown>

  const section = parsed[dependency.section] as
    | Record<string, unknown>
    | undefined

  if (section != null) {
    delete section[dependency.name]
  }

  await writeWorkspaceFileText(
    vscode,
    packageJsonUri,
    `${JSON.stringify(parsed, null, 2)}\n`,
  )

  // Also remove node_modules/<name> (top-level) in the workspace fs
  try {
    await vscode.workspace.fs.delete(
      vscode.Uri.joinPath(rootUri, 'node_modules', dependency.name),
      { recursive: true },
    )
  } catch {
    // not installed locally: fine
  }
}

/*
 * npm view: registry metadata for one package (full JSON document so
 * description/license/homepage are available).
 */
export type NpmPackageView = {
  name: string
  description?: string
  latest: string
  license?: string
  homepage?: string
  distTags: Record<string, string>
  versionCount: number
}

export async function viewPackage(
  packageName: string,
): Promise<NpmPackageView> {
  const response = await fetch(registryUrl(packageName))

  if (!response.ok) {
    throw new Error(
      `npm registry lookup for ${packageName} failed: ${response.status}`,
    )
  }

  const manifest = await response.json() as {
    name?: string
    description?: string
    license?: string
    homepage?: string
    'dist-tags'?: Record<string, string>
    versions?: Record<string, unknown>
  }

  return {
    name: manifest.name ?? packageName,
    description: manifest.description,
    latest: manifest['dist-tags']?.latest ?? '(unknown)',
    license: manifest.license,
    homepage: manifest.homepage,
    distTags: manifest['dist-tags'] ?? {},
    versionCount: Object.keys(manifest.versions ?? {}).length,
  }
}

/*
 * npm ls: top-level packages present in the workspace node_modules, with
 * their installed version and (when known) the requested range.
 */
export type InstalledPackage = {
  name: string
  version: string
  range?: string
  section?: NpmDependencySection
  scoped?: boolean
}

export async function listInstalledPackages(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<InstalledPackage[]> {
  const nodeModulesUri = vscode.Uri.joinPath(rootUri, 'node_modules')

  let entries: [string, vscodeType.FileType][]

  try {
    entries = await vscode.workspace.fs.readDirectory(nodeModulesUri)
  } catch {
    return []
  }

  const dependencies = await readWorkspaceDependencies(vscode, rootUri)
  const byName = new Map(dependencies.map((dep) => [dep.name, dep]))

  const result: InstalledPackage[] = []

  const readVersion = async (
    packageDir: vscodeType.Uri,
    name: string,
  ): Promise<string> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(packageDir, name, 'package.json'),
      )

      const parsed = JSON.parse(DECODER.decode(bytes)) as {
        version?: string
      }

      return parsed.version ?? '(unknown)'
    } catch {
      return '(unknown)'
    }
  }

  for (const [entryName, fileType] of entries) {
    if (fileType !== vscode.FileType.Directory) {
      continue
    }

    if (entryName.startsWith('@')) {
      /*
       * Scope directory: descend one level for the actual packages.
       */
      const scopeEntries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.joinPath(nodeModulesUri, entryName),
      )

      for (const [packageName, scopedType] of scopeEntries) {
        if (scopedType !== vscode.FileType.Directory) {
          continue
        }

        const fullName = `${entryName}/${packageName}`
        const dependency = byName.get(fullName)

        result.push({
          name: fullName,
          version: await readVersion(nodeModulesUri, fullName),
          range: dependency?.range,
          section: dependency?.section,
          scoped: true,
        })
      }

      continue
    }

    const dependency = byName.get(entryName)

    result.push({
      name: entryName,
      version: await readVersion(nodeModulesUri, entryName),
      range: dependency?.range,
      section: dependency?.section,
    })
  }

  return result.sort((left, right) => left.name.localeCompare(right.name))
}

/*
 * npm prune: remove top-level packages under node_modules that are neither
 * declared in package.json nor required by anything that IS declared.
 *
 * The "required transitively" part matters because the flat installer places
 * every dependency closure member at node_modules top level — pruning purely
 * against declared sections would delete packages other packages need.
 */
export async function listExtraneousPackages(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<InstalledPackage[]> {
  const installed = await listInstalledPackages(vscode, rootUri)

  const installedByName = new Map(
    installed
      .filter((entry) => entry.version !== '(unknown)')
      .map((entry) => [entry.name, entry]),
  )

  const declared = await readWorkspaceDependencies(vscode, rootUri)

  const keep = new Set<string>()

  const readAllRequirements = async (
    name: string,
  ): Promise<string[]> => {
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(rootUri, 'node_modules', ...name.split('/'), 'package.json'),
      )

      const manifest = JSON.parse(DECODER.decode(bytes)) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
        peerDependenciesMeta?: Record<string, { optional?: boolean }>
      }

      const required: string[] = Object.keys(manifest.dependencies ?? {})

      if (manifest.peerDependencies != null) {
        const peerMeta = manifest.peerDependenciesMeta ?? {}

        for (const [peerName, peerRange] of Object.entries(
          manifest.peerDependencies,
        )) {
          if (peerRange.length > 0 && !peerMeta[peerName]?.optional) {
            required.push(peerName)
          }
        }
      }

      return required
    } catch {
      return []
    }
  }

  const queue = [...new Set(declared.map((dep) => dep.name))]

  for (const name of queue) {
    if (installedByName.has(name)) {
      keep.add(name)
    }
  }

  while (queue.length > 0) {
    const name = queue.shift() as string

    if (!keep.has(name)) {
      continue
    }

    for (const requiredName of await readAllRequirements(name)) {
      if (keep.has(requiredName)) {
        continue
      }

      if (!installedByName.has(requiredName)) {
        continue
      }

      keep.add(requiredName)
      queue.push(requiredName)
    }
  }

  /*
   * Packages without a readable package.json (corrupt/partial installs) have
   * no way to prove they are needed - npm prune removes those too.
   */
  return installed.filter((entry) => !keep.has(entry.name))
}

export async function pruneExtraneousPackages(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  onRemoved: (name: string) => void,
): Promise<number> {
  const extraneous = await listExtraneousPackages(vscode, rootUri)

  let removedCount = 0
  const removedNames = new Set<string>()

  for (const entry of extraneous) {
    try {
      await vscode.workspace.fs.delete(
        vscode.Uri.joinPath(rootUri, 'node_modules', ...entry.name.split('/')),
        { recursive: true },
      )

      removedNames.add(entry.name)
      onRemoved(entry.name)
      removedCount++
    } catch {
      // already gone or undeletable: leave it alone
    }
  }

  if (removedNames.size > 0) {
    try {
      const lockPath = vscode.Uri.joinPath(
        rootUri,
        'node_modules',
        '.package-lock.json',
      )

      const lockBytes = await vscode.workspace.fs.readFile(lockPath)
      const lock = JSON.parse(DECODER.decode(lockBytes)) as Record<
        string,
        unknown
      >

      for (const name of removedNames) {
        delete lock[name]
      }

      await writeWorkspaceFileText(
        vscode,
        lockPath,
        `${JSON.stringify(lock, null, 2)}\n`,
      )
    } catch {
      // no lockfile or unreadable: nothing to sync
    }
  }

  return removedCount
}

/*
 * npm outdated: compare each declared dependency's installed version
 * against the registry's latest dist-tag.
 */
export type OutdatedPackage = {
  name: string
  range: string
  section: NpmDependencySection
  installed?: string
  latest: string
}

export async function checkOutdatedPackages(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<OutdatedPackage[]> {
  const dependencies = await readWorkspaceDependencies(vscode, rootUri)

  const nodeModulesUri = vscode.Uri.joinPath(rootUri, 'node_modules')

  const results: OutdatedPackage[] = []

  for (const dependency of dependencies) {
    let installed: string | undefined

    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(nodeModulesUri, dependency.name, 'package.json'),
      )

      const parsed = JSON.parse(DECODER.decode(bytes)) as {
        version?: string
      }

      installed = parsed.version
    } catch {
      // not installed locally
    }

    let latest = '(registry lookup failed)'

    try {
      const response = await fetch(registryUrl(dependency.name), {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      })

      if (response.ok) {
        const manifest = await response.json() as {
          'dist-tags'?: Record<string, string>
        }

        latest = manifest['dist-tags']?.latest ?? latest
      }
    } catch {
      // keep the placeholder
    }

    results.push({
      name: dependency.name,
      range: dependency.range,
      section: dependency.section,
      installed,
      latest,
    })
  }

  return results
}

