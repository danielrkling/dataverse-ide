import { PackageManager, VirtualFS } from 'almostnode'

import type * as vscodeType from 'vscode'

import {
  contributeExtensionManifest,
} from '../api.js'

import {
  createPanelIcon,
  PANEL_GLYPHS,
} from '../panels.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

import {
  installPackages,
  loadPackageJsonIntoVfs,
  readWorkspaceDependencies,
  uninstallDependency,
  fetchPackageVersions,
  writeNodeModulesBackToWorkspace,
  writePackageJsonBackToWorkspace,
  listInstalledPackages,
  viewPackage,
  checkOutdatedPackages,
  type NpmDependency,
  type NpmDependencySection,
} from './packageBridge.js'

/*
 * The shared VFS is owned collectively: node-runtime requires packages out
 * of it, npm installs into it.
 */
import { getSharedVfs } from '../sharedVfs.js'

/*
 * npm extension: resolves and installs real npm packages into the workspace
 * using almostnode's PackageManager (registry metadata + tarball extraction,
 * ESM preserved for the esbuild/rolldown bundle pipeline).
 *
 * "Dataverse IDE" activity bar sidebar: the "npm Packages" tree lists
 * dependencies + devDependencies; clicking a dependency offers actions
 * (install a specific version / uninstall / open the registry page).
 */

const COMMAND_INSTALL = 'dataverseIde.npm.install'
const COMMAND_INSTALL_ALL = 'dataverseIde.npm.installAll'
const COMMAND_ADD_DEPENDENCY = 'dataverseIde.npm.addDependency'
const COMMAND_DEPENDENCY_ACTION = 'dataverseIde.npm.dependencyAction'
const COMMAND_REFRESH_PACKAGES = 'dataverseIde.npm.refreshPackages'
const COMMAND_LS = 'dataverseIde.npm.ls'
const COMMAND_VIEW = 'dataverseIde.npm.view'
const COMMAND_OUTDATED = 'dataverseIde.npm.outdated'

type PackageTreeElementData =
  | {
      kind: 'section'
      label: string
      section: NpmDependencySection
    }
  | {
      kind: 'dependency'
      dependency: NpmDependency
    }

class PackageTreeElement {
  constructor(public readonly data: PackageTreeElementData) {}
}

type TreeDeps = {
  vscode: typeof vscodeType
  rootUri: vscodeType.Uri
  onRefreshChildren: () => void
}

class DependenciesTreeProvider
  implements vscodeType.TreeDataProvider<PackageTreeElement>
{
  private readonly onDidChangeEmitter: vscodeType.EventEmitter<
    PackageTreeElement | undefined
  >

  readonly onDidChangeTreeData: vscodeType.Event<
    PackageTreeElement | undefined
  >

  /*
   * Field initializers run before constructor parameter properties are
   * assigned, so this.vscode (this.deps.vscode) is not yet available there;
   * the emitter must therefore be created in the constructor body.
   */
  constructor(private readonly deps: TreeDeps) {
    this.onDidChangeEmitter = new deps.vscode.EventEmitter()
    this.onDidChangeTreeData = this.onDidChangeEmitter.event
  }

  private get vscode(): typeof vscodeType {
    return this.deps.vscode
  }

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined)
  }

  async getChildren(
    element?: PackageTreeElement,
  ): Promise<PackageTreeElement[]> {
    const dependencies = await readWorkspaceDependencies(
      this.deps.vscode,
      this.deps.rootUri,
    )

    if (element == null) {
      return [
        new PackageTreeElement({
          kind: 'section',
          label: 'Dependencies',
          section: 'dependencies',
        }),
        new PackageTreeElement({
          kind: 'section',
          label: 'Dev Dependencies',
          section: 'devDependencies',
        }),
      ]
    }

    if (element.data.kind !== 'section') {
      return []
    }

    const { section } = element.data

    return dependencies
      .filter((dependency) => dependency.section === section)
      .map((dependency) => new PackageTreeElement({
        kind: 'dependency',
        dependency,
      }))
  }

  getTreeItem(element: PackageTreeElement): vscodeType.TreeItem {
    if (element.data.kind === 'section') {
      const item = new this.vscode.TreeItem(
        element.data.label,
        this.vscode.TreeItemCollapsibleState.Collapsed,
      )

      return item
    }

    const { dependency } = element.data

    const item = new this.vscode.TreeItem(
      dependency.name,
      this.vscode.TreeItemCollapsibleState.None,
    )

    item.description = dependency.range

    item.command = {
      command: COMMAND_DEPENDENCY_ACTION,
      title: 'Open dependency actions',
      arguments: [dependency],
    }

    return item
  }
}

async function createPackageManager(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ packageManager: PackageManager; vfs: VirtualFS } | undefined> {
  const vfs = getSharedVfs()

  const loaded = await loadPackageJsonIntoVfs(vscode, rootUri, vfs)

  if (!loaded) {
    return undefined
  }

  const packageManager = new PackageManager(vfs, { cwd: '/' })

  return { packageManager, vfs }
}

function parseSpecs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0)
}

export default {
  id: 'npm',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'npm',
      displayName: 'Dataverse IDE npm',
      description: 'Install and manage npm packages in the workspace.',
      commands: [
        {
          command: COMMAND_INSTALL,
          title: 'npm: Install Package',
        },
        {
          command: COMMAND_INSTALL_ALL,
          title: 'npm: Install All Dependencies (package.json)',
        },
        {
          command: COMMAND_ADD_DEPENDENCY,
          title: 'npm: Add Dependency…',
        },
        {
          command: COMMAND_LS,
          title: 'npm: List Installed Packages',
        },
        {
          command: COMMAND_VIEW,
          title: 'npm: View Package Info…',
        },
        {
          command: COMMAND_OUTDATED,
          title: 'npm: Check Outdated Dependencies',
        },
      ],
      views: {
        containerId: 'dataverseIde.npm',
        containerTitle: 'npm',
        icon: createPanelIcon(PANEL_GLYPHS.package),
        views: [
          {
            id: 'dataverseIde.npm.packages',
            name: 'npm Packages',
          },
        ],
      },
    })

    async function installFromSpecs(specs: string[]): Promise<void> {
      const setup = await createPackageManager(
        vscode,
        context.workspaceRootUri,
      )

      if (setup == null) {
        await vscode.window.showErrorMessage(
          'npm: The workspace has no valid package.json.',
        )

        return
      }

      try {
        const added = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `npm: installing ${specs.join(', ')}…`,
            cancellable: false,
          },
          async () => {
            const installed = await installPackages(
              setup.packageManager,
              specs,
              (message) => {
                outputChannel.appendLine(`[npm] ${message}`)
              },
            )

            await writeNodeModulesBackToWorkspace(
              vscode,
              context.workspaceRootUri,
              setup.vfs,
            )

            await writePackageJsonBackToWorkspace(
              vscode,
              context.workspaceRootUri,
              setup.vfs,
            )

            return installed
          },
        )

        outputChannel.show(true)
        dependencyTreeProvider.refresh()

        outputChannel.appendLine(
          `[npm] Installed: ${added.join(', ')}.`,
        )

        await vscode.window.showInformationMessage(
          `npm: installed ${added.join(', ')}.`,
        )
      } catch (error) {
        console.error('[npm] install failed:', error)

        const message =
          error instanceof Error ? error.message : String(error)

        outputChannel.appendLine(`[npm] install failed: ${message}`)
        outputChannel.show(true)

        await vscode.window.showErrorMessage(
          `npm install failed: ${message}`,
        )
      }
    }

    const installCommand = vscode.commands.registerCommand(
      COMMAND_INSTALL,
      async (arg?: string | unknown) => {
        const specs =
          typeof arg === 'string' && arg.trim().length > 0
            ? parseSpecs(arg)
            : undefined

        if (specs != null) {
          await installFromSpecs(specs)
          return
        }

        const specInput = await vscode.window.showInputBox({
          title: 'npm: Install Package',
          prompt: 'Enter one or more packages (space separated, e.g. "lodash dayjs@1.11.0").',
          placeHolder: 'lodash',
          ignoreFocusOut: true,
        })

        if (specInput == null || specInput.trim().length === 0) {
          return
        }

        await installFromSpecs(parseSpecs(specInput))
      },
    )

    const installAllCommand = vscode.commands.registerCommand(
      COMMAND_INSTALL_ALL,
      async () => {
        const setup = await createPackageManager(
          vscode,
          context.workspaceRootUri,
        )

        if (setup == null) {
          await vscode.window.showErrorMessage(
            'npm: The workspace has no valid package.json.',
          )

          return
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'npm: installing all dependencies…',
              cancellable: false,
            },
            async () => {
              const result = await setup.packageManager.installFromPackageJson({
                onProgress: (message) => {
                  outputChannel.appendLine(`[npm] ${message}`)
                },
              })

              const fileCount = await writeNodeModulesBackToWorkspace(
                vscode,
                context.workspaceRootUri,
                setup.vfs,
              )

              outputChannel.show(true)
              dependencyTreeProvider.refresh()

              outputChannel.appendLine(
                `[npm] Wrote ${fileCount} files to node_modules. Packages: ${result.added.join(', ')}.`,
              )
            },
          )

          await vscode.window.showInformationMessage(
            'npm: all dependencies installed.',
          )
        } catch (error) {
          console.error('[npm] install-all failed:', error)

          const message =
            error instanceof Error ? error.message : String(error)

          outputChannel.appendLine(`[npm] install failed: ${message}`)
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            `npm install failed: ${message}`,
          )
        }
      },
    )

    const dependencyTreeProvider = new DependenciesTreeProvider({
      vscode,
      rootUri: context.workspaceRootUri,
      onRefreshChildren: () => {
        // requestChildren are re-read on each getChildren call
      },
    })

    const dependencyActionCommand = vscode.commands.registerCommand(
      COMMAND_DEPENDENCY_ACTION,
      async (dependency: NpmDependency) => {
        const action = await vscode.window.showQuickPick(
          [
            {
              label: 'Install specific version…',
              detail: `choose a version of ${dependency.name}; updates ${dependency.section} and node_modules`,
              pick: 'version',
            },
            {
              label: 'Uninstall',
              detail: `remove ${dependency.name} from package.json and node_modules`,
              pick: 'uninstall',
            },
            {
              label: 'Open registry page',
              detail: 'open the package page on npmjs.com',
              pick: 'registry',
            },
          ],
          {
            title: `npm: ${dependency.name}@${dependency.range}`,
          },
        )

        if (action == null) {
          return
        }

        if (action.pick === 'registry') {
          void vscode.env.openExternal(
            vscode.Uri.parse(
              `https://www.npmjs.com/package/${dependency.name}`,
            ),
          )

          return
        }

        if (action.pick === 'uninstall') {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `npm: uninstalling ${dependency.name}…`,
              cancellable: false,
            },
            async () => {
              await uninstallDependency(
                vscode,
                context.workspaceRootUri,
                dependency,
              )
            },
          )

          dependencyTreeProvider.refresh()

          await vscode.window.showInformationMessage(
            `npm: uninstalled ${dependency.name}.`,
          )

          return
        }

        let versions: string[]

        try {
          versions = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `npm: fetching versions of ${dependency.name}…`,
              cancellable: false,
            },
            async () => fetchPackageVersions(dependency.name),
          )
        } catch (error) {
          await vscode.window.showErrorMessage(
            `npm: ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }

        const selectedVersion = await vscode.window.showQuickPick(
          versions.map((version) => ({ label: version })),
          {
            title: `npm: ${dependency.name} — select version`,
            placeHolder: 'Select the version to install.',
            ignoreFocusOut: true,
          },
        )

        if (selectedVersion == null) {
          return
        }

        await installFromSpecs([
          `${dependency.name}@${selectedVersion.label}`,
        ])
      },
    )

    const addDependencyCommand = vscode.commands.registerCommand(
      COMMAND_ADD_DEPENDENCY,
      async () => {
        const specInput = await vscode.window.showInputBox({
          title: 'npm: Add Dependency',
          prompt: 'Enter the package name (optionally with @scope).',
          placeHolder: 'lodash',
          ignoreFocusOut: true,
        })

        if (specInput == null || specInput.trim().length === 0) {
          return
        }

        await installFromSpecs(parseSpecs(specInput))
      },
    )

    const refreshCommand = vscode.commands.registerCommand(
      COMMAND_REFRESH_PACKAGES,
      async () => {
        dependencyTreeProvider.refresh()
      },
    )

    const lsCommand = vscode.commands.registerCommand(
      COMMAND_LS,
      async () => {
        const installed = await listInstalledPackages(
          vscode,
          context.workspaceRootUri,
        )

        if (installed.length === 0) {
          await vscode.window.showInformationMessage(
            'npm: nothing is installed in node_modules yet.',
          )

          return
        }

        outputChannel.show(true)
        outputChannel.appendLine(`[npm ls] ${installed.length} top-level package(s):`)

        for (const entry of installed) {
          const section = entry.section != null ? ` (${entry.section})` : ''
          const range = entry.range != null ? ` wanted ${entry.range}` : ''

          outputChannel.appendLine(
            `[npm ls] ${entry.name}@${entry.version}${range}${section}`,
          )
        }
      },
    )

    const viewCommand = vscode.commands.registerCommand(
      COMMAND_VIEW,
      async () => {
        const packageName = await vscode.window.showInputBox({
          title: 'npm: View Package Info',
          prompt: 'Enter the package name to look up on the registry.',
          placeHolder: 'lodash',
          ignoreFocusOut: true,
        })

        if (packageName == null || packageName.trim().length === 0) {
          return
        }

        try {
          const info = await viewPackage(packageName.trim())

          outputChannel.show(true)
          outputChannel.appendLine(`[npm view] ${info.name}`)
          outputChannel.appendLine(`[npm view] latest: ${info.latest}`)

          if (info.description != null) {
            outputChannel.appendLine(`[npm view] description: ${info.description}`)
          }

          if (info.license != null) {
            outputChannel.appendLine(`[npm view] license: ${info.license}`)
          }

          if (info.homepage != null) {
            outputChannel.appendLine(`[npm view] homepage: ${info.homepage}`)
          }

          outputChannel.appendLine(
            `[npm view] versions: ${info.versionCount}, dist-tags: ${Object.entries(info.distTags).map(([tag, version]) => `${tag}=${version}`).join(', ')}`,
          )
        } catch (error) {
          await vscode.window.showErrorMessage(
            `npm view failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      },
    )

    const outdatedCommand = vscode.commands.registerCommand(
      COMMAND_OUTDATED,
      async () => {
        const outdated = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'npm: checking outdated dependencies…',
            cancellable: false,
          },
          () => checkOutdatedPackages(vscode, context.workspaceRootUri),
        )

        if (outdated.length === 0) {
          await vscode.window.showInformationMessage(
            'npm: no dependencies declared in package.json.',
          )

          return
        }

        const stale = outdated.filter(
          (entry) => entry.installed != null && entry.installed !== entry.latest,
        )

        outputChannel.show(true)
        outputChannel.appendLine(
          `[npm outdated] ${outdated.length} dependency/dependencies, ${stale.length} behind latest:`,
        )

        for (const entry of outdated) {
          const status =
            entry.installed == null
              ? 'not installed'
              : entry.installed === entry.latest
                ? 'up to date'
                : 'OUTDATED'

          outputChannel.appendLine(
            `[npm outdated] ${entry.name} — wanted ${entry.range}, installed ${entry.installed ?? '—'}, latest ${entry.latest} [${status}] (${entry.section})`,
          )
        }

        if (stale.length > 0) {
          const selection = await vscode.window.showInformationMessage(
            `npm: ${stale.length} package(s) are behind the latest version.`,
            'Update All',
          )

          if (selection === 'Update All') {
            await installFromSpecs(
              stale
                /*
                 * Install the concrete latest version fetched above;
                 * "@latest" is a dist-tag that the package manager does
                 * not resolve.
                 */
                .map((entry) =>
                  entry.latest.startsWith('(')
                    ? entry.name
                    : `${entry.name}@${entry.latest}`,
                ),
            )
          }
        }
      },
    )

    const treeRegistration = vscode.window.registerTreeDataProvider(
      'dataverseIde.npm.packages',
      dependencyTreeProvider,
    )

    const packageJsonSaveWatcher = vscode.workspace.onDidSaveTextDocument(
      (document) => {
        if (document.uri.path.endsWith('package.json')) {
          dependencyTreeProvider.refresh()
        }
      },
    )

    outputChannel.appendLine('[npm] extension activated.')

    return {
      dispose() {
        packageJsonSaveWatcher.dispose()
        treeRegistration.dispose?.()

        installCommand.dispose()
        installAllCommand.dispose()
        addDependencyCommand.dispose()
        dependencyActionCommand.dispose()
        refreshCommand.dispose()
        lsCommand.dispose()
        viewCommand.dispose()
        outdatedCommand.dispose()
      },
    }
  },
} satisfies IdeExtension
