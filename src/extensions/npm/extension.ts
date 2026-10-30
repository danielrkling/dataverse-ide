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
  readWorkspaceDependencies,
  uninstallDependency,
  fetchPackageVersions,
  listInstalledPackages,
  listExtraneousPackages,
  pruneExtraneousPackages,
  viewPackage,
  checkOutdatedPackages,
  type NpmDependency,
  type NpmDependencySection,
} from './packageBridge.js'
import { directInstall } from './directInstaller.js'

/*
 * Install flow: resolution + tarball extraction write straight through
 * vscode.workspace.fs (see ./directInstaller.ts). The shared VFS is left to
 * the node-runtime extension, which still mounts workspace files itself.
 */

/*
 * npm extension: resolves and installs real npm packages into the workspace
 * straight through vscode.workspace.fs (registry metadata + tarball
 * extraction, ESM preserved for the esbuild/rolldown bundle pipeline).
 *
 * "Dataverse IDE" activity bar sidebar: the "npm Packages" tree lists
 * dependencies + devDependencies; clicking a dependency offers actions
 * (install a specific version / uninstall / open the registry page).
 */

const COMMAND_INSTALL = 'dataverseIde.npm.install'
const COMMAND_INSTALL_ALL = 'dataverseIde.npm.installAll'
const COMMAND_ADD_DEPENDENCY = 'dataverseIde.npm.addDependency'
const COMMAND_ADD_DEV_DEPENDENCY = 'dataverseIde.npm.addDevDependency'
const COMMAND_INSTALL_DEPENDENCY_VERSION =
  'dataverseIde.npm.installDependencyVersion'

const COMMAND_UNINSTALL_DEPENDENCY =
  'dataverseIde.npm.uninstallDependency'

const COMMAND_OPEN_DEPENDENCY_REGISTRY =
  'dataverseIde.npm.openDependencyRegistry'
const COMMAND_REFRESH_PACKAGES = 'dataverseIde.npm.refreshPackages'
const COMMAND_LS = 'dataverseIde.npm.ls'
const COMMAND_VIEW = 'dataverseIde.npm.view'
const COMMAND_OUTDATED = 'dataverseIde.npm.outdated'

const COMMAND_PRUNE = 'dataverseIde.npm.prune'

const DEPENDENCY_ACTIONS_SUBMENU =
  'dataverseIde.npm.dependencyActions'

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
  constructor(public readonly data: PackageTreeElementData) { }
}

type TreeDeps = {
  vscode: typeof vscodeType
  rootUri: vscodeType.Uri
  onRefreshChildren: () => void
}

class DependenciesTreeProvider
  implements vscodeType.TreeDataProvider<PackageTreeElement> {
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

      item.contextValue =
        element.data.section === 'dependencies'
          ? 'dataverseIde.npm.dependenciesSection'
          : 'dataverseIde.npm.devDependenciesSection'

      return item
    }

    const { dependency } = element.data

    const item = new this.vscode.TreeItem(
      dependency.name,
      this.vscode.TreeItemCollapsibleState.None,
    )

    item.description = dependency.range
    item.contextValue = 'dataverseIde.npm.dependency'


    return item
  }
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
          icon: '$(add)',
        },
        {
          command: COMMAND_INSTALL_ALL,
          title: 'npm: Install All Dependencies (package.json)',
          icon: '$(cloud-download)',
        },
        {
          command: COMMAND_ADD_DEPENDENCY,
          title: 'npm: Add Dependency…',
          icon: '$(add)',
        },
        {
          command: COMMAND_ADD_DEV_DEPENDENCY,
          title: 'npm: Add Dev Dependency…',
          icon: '$(add)',
        },
        {
          command: COMMAND_INSTALL_DEPENDENCY_VERSION,
          title: 'npm: Install Specific Dependency Version…',
          icon: '$(versions)',
        },
        {
          command: COMMAND_UNINSTALL_DEPENDENCY,
          title: 'npm: Uninstall Dependency',
          icon: '$(trash)',
        },
        {
          command: COMMAND_OPEN_DEPENDENCY_REGISTRY,
          title: 'npm: Open Dependency Registry Page',
          icon: '$(link-external)',
        },
        {
          command: COMMAND_REFRESH_PACKAGES,
          title: 'npm: Refresh Package Tree',
          icon: '$(refresh)',
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
        {
          command: COMMAND_PRUNE,
          title: 'npm: Prune Extraneous Packages',
          icon: '$(fold-down)',
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
      menus: [
        {
          menu: 'view/title',
          command: COMMAND_INSTALL,
          when: 'view == dataverseIde.npm.packages',
          group: 'navigation@10',
        },
        {
          /*
           * Appears as an action icon in the npm Packages tree header.
           */
          menu: 'view/title',
          command: COMMAND_INSTALL_ALL,
          when: 'view == dataverseIde.npm.packages',
          group: 'navigation@20',
        },
        {
          menu: 'view/title',
          command: COMMAND_REFRESH_PACKAGES,
          when: 'view == dataverseIde.npm.packages',
          group: 'navigation@30',
        },
        {
          menu: 'view/title',
          command: COMMAND_PRUNE,
          when: 'view == dataverseIde.npm.packages',
          group: 'navigation@40',
        },
        /*
         * Inline plus actions on the section rows.
         */
        {
          menu: 'view/item/context',
          command: COMMAND_ADD_DEPENDENCY,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.dependenciesSection',
          group: 'inline@1',
        },
        {
          menu: 'view/item/context',
          command: COMMAND_ADD_DEV_DEPENDENCY,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.devDependenciesSection',
          group: 'inline@1',
        },
      
        /*
         * Explicit inline ellipsis button on each dependency row.
         *
         * Clicking it opens the nested menu entries below rather than a Quick Pick.
         */
        {
          menu: 'view/item/context',
          submenu: DEPENDENCY_ACTIONS_SUBMENU,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.dependency',
          group: 'inline@20',
        },
      
        /*
         * Entries rendered inside the dependency submenu.
         */
        {
          menu: DEPENDENCY_ACTIONS_SUBMENU,
          command: COMMAND_INSTALL_DEPENDENCY_VERSION,
          when: 'viewItem == dataverseIde.npm.dependency',
          group: 'navigation@10',
        },
        {
          menu: DEPENDENCY_ACTIONS_SUBMENU,
          command: COMMAND_UNINSTALL_DEPENDENCY,
          when: 'viewItem == dataverseIde.npm.dependency',
          group: 'navigation@20',
        },
        {
          menu: DEPENDENCY_ACTIONS_SUBMENU,
          command: COMMAND_OPEN_DEPENDENCY_REGISTRY,
          when: 'viewItem == dataverseIde.npm.dependency',
          group: 'navigation@30',
        },
      
        /*
         * Keep the same actions available directly from right-click.
         */
        {
          menu: 'view/item/context',
          command: COMMAND_INSTALL_DEPENDENCY_VERSION,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.dependency',
          group: 'navigation@10',
        },
        {
          menu: 'view/item/context',
          command: COMMAND_UNINSTALL_DEPENDENCY,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.dependency',
          group: 'navigation@20',
        },
        {
          menu: 'view/item/context',
          command: COMMAND_OPEN_DEPENDENCY_REGISTRY,
          when:
            'view == dataverseIde.npm.packages && viewItem == dataverseIde.npm.dependency',
          group: 'navigation@30',
        },
      ],
      submenus: [
        {
          id: DEPENDENCY_ACTIONS_SUBMENU,
          label: 'Dependency Actions',
          icon: '$(ellipsis)',
        },
      ],
    })

    function toDependency(
      value: unknown,
    ): NpmDependency | undefined {
      if (
        typeof value === 'object' &&
        value != null &&
        'name' in value &&
        'range' in value &&
        'section' in value
      ) {
        const dependency = value as Partial<NpmDependency>
    
        if (
          typeof dependency.name === 'string' &&
          typeof dependency.range === 'string' &&
          (
            dependency.section === 'dependencies' ||
            dependency.section === 'devDependencies'
          )
        ) {
          return dependency as NpmDependency
        }
      }
    
      if (
        typeof value === 'object' &&
        value != null &&
        'data' in value
      ) {
        const treeElement = value as {
          data?: PackageTreeElementData
        }
    
        if (treeElement.data?.kind === 'dependency') {
          return treeElement.data.dependency
        }
      }
    
      return undefined
    }

    const sectionLabelOf = (section: NpmDependencySection): string =>
      section === 'devDependencies' ? 'dev dependency' : 'dependency'

    const progressToChannel = (message: string): void => {
      outputChannel.appendLine(`[npm] ${message}`)
    }

    function reportFailure(operation: string, error: unknown): void {
      console.error(`[npm] ${operation} failed:`, error)

      const message =
        error instanceof Error ? error.message : String(error)

      outputChannel.appendLine(`[npm] ${operation} failed: ${message}`)
      outputChannel.show(true)

      void vscode.window.showErrorMessage(
        `npm ${operation} failed: ${message}`,
      )
    }

    async function installFromSpecs(
      specs: string[],
      section: NpmDependencySection = 'dependencies',
    ): Promise<void> {
      try {
        const sectionLabel = sectionLabelOf(section)

        const added = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `npm: installing ${specs.join(', ')}…`,
            cancellable: false,
          },
          async () =>
            directInstall(
              vscode,
              context.workspaceRootUri,
              { specs, onProgress: progressToChannel },
              section,
            ).then((result) => result.installed),
        )

        outputChannel.show(true)
        dependencyTreeProvider.refresh()

        outputChannel.appendLine(
          `[npm] Installed ${sectionLabel}: ${added.join(', ')}.`,
        )

        await vscode.window.showInformationMessage(
          `npm: installed ${added.join(', ')} as ${sectionLabel}${added.length === 1 ? '' : ' packages'}.`,
        )
      } catch (error) {
        reportFailure('install', error)
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

        // no-arg entry point shares the same prompt as Add Dependency, so
        // "install something" and "add dependency" cannot drift apart.
        await promptForDependencySpec('dependencies')
      },
    )

    const installAllCommand = vscode.commands.registerCommand(
      COMMAND_INSTALL_ALL,
      async () => {
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'npm: installing all dependencies…',
              cancellable: false,
            },
            async () => {
              const result = await directInstall(
                vscode,
                context.workspaceRootUri,
                {
                  allDependencies: true,
                  onProgress: progressToChannel,
                },
              )

              outputChannel.show(true)
              dependencyTreeProvider.refresh()

              outputChannel.appendLine(
                `[npm] Wrote ${result.installed.length} packages to node_modules. Packages: ${result.installed.join(', ')}.`,
              )
            },
          )

          await vscode.window.showInformationMessage(
            'npm: all dependencies installed.',
          )
        } catch (error) {
          reportFailure('install-all', error)
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


    const installDependencyVersionCommand = vscode.commands.registerCommand(
      COMMAND_INSTALL_DEPENDENCY_VERSION,
      async (argument: unknown) => {
        const dependency = toDependency(argument)
    
        if (dependency == null) {
          await vscode.window.showWarningMessage(
            'npm: select a dependency first.',
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
          versions.map((version) => ({
            label: version,
          })),
          {
            title: `npm: ${dependency.name} — select version`,
            placeHolder: 'Select the version to install.',
            ignoreFocusOut: true,
          },
        )
    
        if (selectedVersion == null) {
          return
        }
    
        /*
         * Preserve the package's existing dependency category.
         */
        await installFromSpecs(
          [`${dependency.name}@${selectedVersion.label}`],
          dependency.section,
        )
      },
    )
    
    const uninstallDependencyCommand = vscode.commands.registerCommand(
      COMMAND_UNINSTALL_DEPENDENCY,
      async (argument: unknown) => {
        const dependency = toDependency(argument)
    
        if (dependency == null) {
          await vscode.window.showWarningMessage(
            'npm: select a dependency first.',
          )
    
          return
        }
    
        const confirmation = await vscode.window.showWarningMessage(
          `Uninstall ${dependency.name} from ${dependency.section}?`,
          {
            modal: true,
          },
          'Uninstall',
        )
    
        if (confirmation !== 'Uninstall') {
          return
        }
    
        try {
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
        } catch (error) {
          reportFailure('uninstall', error)
        }
      },
    )
    
    const openDependencyRegistryCommand = vscode.commands.registerCommand(
      COMMAND_OPEN_DEPENDENCY_REGISTRY,
      async (argument: unknown) => {
        const dependency = toDependency(argument)
    
        if (dependency == null) {
          await vscode.window.showWarningMessage(
            'npm: select a dependency first.',
          )
    
          return
        }
    
        void vscode.env.openExternal(
          vscode.Uri.parse(
            `https://www.npmjs.com/package/${dependency.name}`,
          ),
        )
      },
    )

    async function promptForDependencySpec(
      section: NpmDependencySection,
    ): Promise<void> {
      const specInput = await vscode.window.showInputBox({
        title: `npm: Add ${sectionLabelOf(section)}`,
        prompt:
          'Enter one or more packages, optionally with versions, separated by spaces.',
        placeHolder: 'lodash dayjs@1.11.0',
        ignoreFocusOut: true,
      })

      if (specInput == null || specInput.trim().length === 0) {
        return
      }

      await installFromSpecs(
        parseSpecs(specInput),
        section,
      )
    }

    const addDependencyCommand = vscode.commands.registerCommand(
      COMMAND_ADD_DEPENDENCY,
      async () => {
        await promptForDependencySpec('dependencies')
      },
    )

    const addDevDependencyCommand = vscode.commands.registerCommand(
      COMMAND_ADD_DEV_DEPENDENCY,
      async () => {
        await promptForDependencySpec('devDependencies')
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
            /*
             * Install the concrete latest version fetched above. A
             * placeholder "(registry lookup failed)" tag falls back to the
             * bare name, which resolves via dist-tags.latest. Grouped by
             * section so devDependencies are not silently moved into
             * dependencies on update.
             */
            const specsBySection = new Map<NpmDependencySection, string[]>()

            for (const entry of stale) {
              const spec = entry.latest.startsWith('(')
                ? entry.name
                : `${entry.name}@${entry.latest}`

              const group = specsBySection.get(entry.section) ?? []

              group.push(spec)
              specsBySection.set(entry.section, group)
            }

            for (const [section, specs] of specsBySection) {
              await installFromSpecs(specs, section)
            }
          }
        }
      },
    )

    const pruneCommand = vscode.commands.registerCommand(
      COMMAND_PRUNE,
      async () => {
        let extraneous: Awaited<
          ReturnType<typeof listExtraneousPackages>
        > = []

        try {
          extraneous = await listExtraneousPackages(
            vscode,
            context.workspaceRootUri,
          )
        } catch (error) {
          reportFailure('prune (scan)', error)
          return
        }

        if (extraneous.length === 0) {
          await vscode.window.showInformationMessage(
            'npm: node_modules is already in sync with package.json — nothing to prune.',
          )

          return
        }

        const names = extraneous.map((entry) => entry.name).join(', ')

        const confirmation = await vscode.window.showWarningMessage(
          `npm: remove ${extraneous.length} extraneous package${extraneous.length === 1 ? '' : 's'} from node_modules?\n${names}`,
          { modal: true },
          'Prune',
        )

        if (confirmation !== 'Prune') {
          return
        }

        try {
          const removedCount = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'npm: pruning extraneous packages…',
              cancellable: false,
            },
            async () => {
              const removed: string[] = []

              const count = await pruneExtraneousPackages(
                vscode,
                context.workspaceRootUri,
                (name) => {
                  removed.push(name)
                  outputChannel.appendLine(`[npm] removed ${name}`)
                },
              )

              outputChannel.show(true)
              dependencyTreeProvider.refresh()

              outputChannel.appendLine(
                `[npm] Pruned ${count} package${count === 1 ? '' : 's'}: ${removed.join(', ')}.`,
              )

              return count
            },
          )

          await vscode.window.showInformationMessage(
            `npm: pruned ${removedCount} package${removedCount === 1 ? '' : 's'}.`,
          )
        } catch (error) {
          reportFailure('prune', error)
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
        addDevDependencyCommand.dispose()
        installDependencyVersionCommand.dispose()
        uninstallDependencyCommand.dispose()
        openDependencyRegistryCommand.dispose()
        refreshCommand.dispose()
        lsCommand.dispose()
        viewCommand.dispose()
        outdatedCommand.dispose()
      },
    }
  },
} satisfies IdeExtension
