/*
 * Bridge between the workspace (via vscode.workspace.fs) and almostnode's
 * VirtualFS-backed PackageManager.
 *
 * Install flow:
 *   1. Workspace package.json is copied into the VFS so emergent
 *      dependencies can be resolved from the real dependency spec.
 *   2. almostnode PackageManager resolves + extracts real npm tarballs into
 *      the VFS at /node_modules (it transforms ESM packages to CJS by
 *      default, matching its runtime).
 *   3. /node_modules is written back into the real workspace filesystem so
 *      files visible in the explorer, git status, and the node-runtime
 *      extension all agree.
 */
import { VirtualFS } from 'almostnode'
import type { PackageManager } from 'almostnode'

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

async function writeWorkspaceFileText(
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

async function ensureWorkspacePackageJson(
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
    if (
      error instanceof vscode.FileSystemError &&
      error.code === 'FileNotFound'
    ) {
      // fall through to creation
    } else {
      return undefined
    }
  }

  const created = `${JSON.stringify(MINIMAL_PACKAGE_JSON, null, 2)}\n`

  try {
    await writeWorkspaceFileText(vscode, packageJsonUri, created)

    const createdInformation = await vscode.window.showInformationMessage(
      'npm: created a starter package.json in the workspace root.',
      'Open',
    )

    if (createdInformation === 'Open') {
      await vscode.window.showTextDocument(packageJsonUri)
    }

    return created
  } catch {
    return undefined
  }
}

export async function loadPackageJsonIntoVfs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  vfs: VirtualFS,
): Promise<boolean> {
  const text = await ensureWorkspacePackageJson(vscode, rootUri)

  if (text == null) {
    return false
  }

  try {
    JSON.parse(text)

    vfs.writeFileSync('/package.json', text)

    return true
  } catch {
    return false
  }
}

export async function writePackageJsonBackToWorkspace(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  vfs: VirtualFS,
): Promise<void> {
  if (!vfs.existsSync('/package.json')) {
    return
  }

  const text = vfs.readFileSync(
    '/package.json',
    'utf8',
  ) as string

  const packageJsonUri = vscode.Uri.joinPath(rootUri, 'package.json')

  await vscode.workspace.fs.writeFile(
    packageJsonUri,
    ENCODER.encode(text),
  )
}

async function copyVfsSubtree(
  vfs: VirtualFS,
  path: string,
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  fileCountRef: { count: number },
): Promise<void> {
  const workspacePath = path.split('/').slice(1)

  if (workspacePath.length > 0) {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(rootUri, ...workspacePath),
    )
  }

  for (const entry of vfs.readdirSync(path).sort()) {
    const childPath = `${path}/${entry}`.replace(/\/{2,}/g, '/')

    const stats = vfs.statSync(childPath)

    if (stats.isDirectory()) {
      await copyVfsSubtree(
        vfs,
        childPath,
        vscode,
        rootUri,
        fileCountRef,
      )

      continue
    }

    if (stats.isFile()) {
      const content = vfs.readFileSync(childPath)

      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(
          rootUri,
          ...childPath.split('/').slice(1),
        ),
        content instanceof Uint8Array
          ? content
          : ENCODER.encode(content as string),
      )

      fileCountRef.count++
    }
  }
}

export async function writeNodeModulesBackToWorkspace(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  vfs: VirtualFS,
): Promise<number> {
  if (!vfs.existsSync('/node_modules')) {
    return 0
  }

  const fileCountRef = { count: 0 }

  await copyVfsSubtree(
    vfs,
    '/node_modules',
    vscode,
    rootUri,
    fileCountRef,
  )

  return fileCountRef.count
}

export async function installPackages(
  packageManager: PackageManager,
  specs: string[],
  onProgress: (message: string) => void,
): Promise<string[]> {
  const added: string[] = []

  for (const spec of specs) {
    /*
     * transform: false keeps packages byte-perfect as shipped (ESM where the
     * package ships ESM). The node runtime transpiles ESM on the fly, and
     * the esbuild/rolldown extensions bundle raw ESM with tree-shaking.
     */
    const result = await packageManager.install(spec, {
      onProgress,
      save: true,
      transform: false,
    })

    added.push(...result.added)
  }

  return added
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

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.\-+]/).map(Number)
  const rightParts = right.split(/[.\-+]/).map(Number)

  for (let index = 0; index < 3; index++) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart !== rightPart) {
      return rightPart - leftPart
    }
  }

  return right.localeCompare(left)
}

export async function fetchPackageVersions(
  packageName: string,
): Promise<string[]> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%5E', '').replace('%2F', '%2f')}`,
    { headers: { Accept: 'application/vnd.npm.install-v1+json' } },
  )

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

  return versions.sort(compareVersions).slice(0, 200)
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
