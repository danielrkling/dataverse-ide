import {
    ExtensionHostKind,
    registerExtension,
  } from '@codingame/monaco-vscode-api/extensions'
  import type * as vscodeType from 'vscode'
import type { IExtensionManifest } from '@codingame/monaco-vscode-api/extensions'
  
  import {
    addRemote,
    cloneRepository,
    createBranch,
    createCommit,
    deleteLocalBranch,
    deleteRemote,
    fetchRemote,
    discardPaths,
    listRemoteBranches,
    createBranchFrom,
    getGitRepositorySnapshot,
    getHeadCommit,
    getRecentCommits,
    getSyncStatus,
    initializeRepository,
    listLocalBranches,
    listRemotes,
    pullRemote,
    pushRemote,
    readBlobAt,
    checkoutCommit,
    readWorkdirFile,
    stageAll,
    stageExactContent,
    stagePaths,
    switchBranch,
    unstageAll,
    unstagePaths,
    writeWorkdirFile,
    type GitBranch,
    type GitCredentialsProvider,
    type GitFileStatus,
    type GitRemote,
    type GitTreeEntry,
  } from './service.js'

  import {
    createCredentialProvider,
    forgetCredentials,
    type GitCredentialPrompt,
  } from './credentials.js'

  import {
    detectLineDiff,
    selectiveMerge,
    splitLines,
  } from './lineMerge.js'
  
  export type DataverseGitScmController = {
    refresh: () => Promise<void>
    dispose: () => void
  }
  
  let installedController: DataverseGitScmController | undefined
  
  function getStatusIcon(status: GitFileStatus): string {
    switch (status) {
      case 'added':
        return 'diff-added'
  
      case 'untracked':
        return 'new-file'
  
      case 'deleted':
      case 'deleted-and-staged':
        return 'diff-removed'
  
      case 'modified':
      case 'modified-and-staged':
        return 'diff-modified'
  
      case 'clean':
        return 'circle-large-outline'
    }
  }

  function getStatusTooltip(status: GitFileStatus): string {
    switch (status) {
      case 'added':
        return 'Added'
  
      case 'deleted':
        return 'Deleted'
  
      case 'deleted-and-staged':
        return 'Deleted and staged'
  
      case 'untracked':
        return 'Untracked'
  
      case 'modified-and-staged':
        return 'Modified and staged'
  
      case 'modified':
        return 'Modified'
  
      case 'clean':
        return 'Clean'
    }
  }
  

  
  function isDeletedStatus(status: GitFileStatus): boolean {
    return status === 'deleted' || status === 'deleted-and-staged'
  }

  /*
   * Explorer file decorations: Explorer decoration variants used by desktop
   * VS Code's Git integration. A single file can be in the Changes and Staged
   * groups at once; the Explorer shows one letter badge, so staged states get
   * the dedicated staged color (bold-ish letter with their own palette).
   */
  type ExplorerDecoration = {
    badge: string
    colorId: string
  }

  /*
   * Ordered most-severe first: when decorating a folder whose children carry
   * different statuses, the first matching status wins the badge.
   */
  const EXPLORER_DECORATIONS: readonly [
    check: (status: GitFileStatus) => boolean,
    decoration: ExplorerDecoration,
  ][] = [
    [
      (status) => status === 'deleted-and-staged',
      { badge: 'D', colorId: 'gitDecoration.stagedResourceForeground' },
    ],
    [
      (status) => status === 'modified-and-staged',
      { badge: 'M', colorId: 'gitDecoration.stagedResourceForeground' },
    ],
    [
      (status) => status === 'added',
      { badge: 'A', colorId: 'gitDecoration.addedResourceForeground' },
    ],
    [
      (status) => status === 'modified',
      { badge: 'M', colorId: 'gitDecoration.modifiedResourceForeground' },
    ],
    [
      (status) => status === 'deleted',
      { badge: 'D', colorId: 'gitDecoration.deletedResourceForeground' },
    ],
    [
      (status) => status === 'untracked',
      { badge: 'U', colorId: 'gitDecoration.untrackedResourceForeground' },
    ],
  ]

  function getExplorerDecoration(
    status: GitFileStatus,
  ): ExplorerDecoration | undefined {
    return EXPLORER_DECORATIONS.find(([check]) => check(status))?.[1]
  }

  function toResourceUri(
    vscode: typeof vscodeType,
    rootUri: vscodeType.Uri,
    path: string,
  ): vscodeType.Uri {
    return vscode.Uri.joinPath(
      rootUri,
      ...path.split('/').filter((segment) => segment.length > 0),
    )
  }
  
  function createResourceState(
    vscode: typeof vscodeType,
    rootUri: vscodeType.Uri,
    entry: GitTreeEntry,
    group: 'changes' | 'staged',
  ): vscodeType.SourceControlResourceState {
    const resourceUri = toResourceUri(vscode, rootUri, entry.path)
    const deleted = isDeletedStatus(entry.status)

    /*
     * Desktop VS Code opens the diff view (HEAD vs working tree) when a
     * modified file is clicked in Source Control; untracked/added files open
     * the file itself, deleted files cannot be opened at all.
     */
    const opensAsDiff =
      entry.status === 'modified' || entry.status === 'modified-and-staged'

    /*
     * A status-based context value (exposed as the `scmResourceState` when
     * clause context key by the SCM view) supports status-sensitive menus,
     * like the real Git extension's deleted-file handling.
     */
    const contextValue = deleted
      ? `dataverseGit.${entry.status}`
      : entry.status === 'untracked'
        ? 'dataverseGit.untracked'
        : `dataverseGit.${group}`

    return {
      resourceUri,
      contextValue,
  
        decorations: {
            tooltip: getStatusTooltip(entry.status),
            iconPath: new vscode.ThemeIcon(
              getStatusIcon(entry.status),
            ),
            strikeThrough: deleted,
            faded: deleted,
          },
  
      command: opensAsDiff
        ? {
            command: 'dataverseGit.openChanges',
            title: 'Open Changes',
            arguments: [resourceUri],
          }
        : deleted
          ? undefined
          : {
              command: 'vscode.open',
              title: 'Open File',
              arguments: [resourceUri],
            },
    }
  }
  
  export async function installDataverseGitExtension(
    workspaceHandle: FileSystemDirectoryHandle,
    rootUri: vscodeType.Uri,
    options?: {
      credentialStore?: GitCredentialStore

      /*
       * Small key/value metadata store (backed by secret storage) used for
       * things like the "last fetch" timestamp shown in the status bar.
       */
      metadataStore?: GitCredentialStore
    },
  ): Promise<DataverseGitScmController> {
    if (installedController != null) {
      return installedController
    }

    /*
     * Credentials are prompted lazily the first time a remote operation needs
     * them and then cached in secret storage per remote host.
     */
    const promptForCredentials: GitCredentialPrompt = async () => {
      const username = await vscode.window.showInputBox({
        title: 'Git Remote Credentials',
        prompt: 'Enter the credential username. Common values: "x-access-token" (GitHub PAT), "oauth2" (GitLab PAT).',
        ignoreFocusOut: true,
      })

      if (username == null) {
        return undefined
      }

      const password = await vscode.window.showInputBox({
        title: 'Git Remote Credentials',
        prompt: 'Enter the password or personal access token.',
        password: true,
        ignoreFocusOut: true,
      })

      if (password == null) {
        return undefined
      }

      return {
        username: username.trim().length > 0 ? username.trim() : undefined,
        password,
      }
    }

    const credentialProvider: GitCredentialsProvider | undefined =
      options?.credentialStore != null
        ? createCredentialProvider(
            options.credentialStore,
            promptForCredentials,
          )
        : undefined

    const metadataStore = options?.metadataStore

    const LAST_FETCH_KEY = 'dataverseGit.lastFetch'

    async function markFetchedNow(): Promise<void> {
      if (metadataStore == null) {
        return
      }

      try {
        await metadataStore.set(
          LAST_FETCH_KEY,
          new Date().toISOString(),
        )
      } catch (error) {
        console.warn(
          '[Dataverse IDE] Unable to persist last-fetch timestamp.',
          error,
        )
      }
    }
  
    const { getApi } = registerExtension(
      {
        name: 'dataverse-git',
        publisher: 'dataverse',
        version: '0.1.0',
        engines: {
          vscode: '*',
        },
        displayName: 'Dataverse IDE Git',
        description: 'Browser-based Git status integration for Dataverse IDE.',
        contributes: {
            colors: [
              {
                id: 'gitDecoration.modifiedResourceForeground',
                description: 'Explorer decorations: modified resources',
                defaults: {
                  dark: '#E2C08D',
                  light: '#895503',
                  highContrast: '#E2C08D',
                  highContrastLight: '#895503',
                },
              },
              {
                id: 'gitDecoration.deletedResourceForeground',
                description: 'Explorer decorations: deleted resources',
                defaults: {
                  dark: '#C74E39',
                  light: '#AD0707',
                  highContrast: '#C74E39',
                  highContrastLight: '#AD0707',
                },
              },
              {
                id: 'gitDecoration.untrackedResourceForeground',
                description: 'Explorer decorations: untracked resources',
                defaults: {
                  dark: '#73C991',
                  light: '#73C991',
                  highContrast: '#73C991',
                  highContrastLight: '#73C991',
                },
              },
              {
                id: 'gitDecoration.addedResourceForeground',
                description: 'Explorer decorations: added resources',
                defaults: {
                  dark: '#81B88B',
                  light: '#587C0C',
                  highContrast: '#A1E0AD',
                  highContrastLight: '#587C0C',
                },
              },
              {
                id: 'gitDecoration.stagedResourceForeground',
                description: 'Explorer decorations: staged resources',
                defaults: {
                  dark: '#B78A5E',
                  light: '#347433',
                  highContrast: '#E2C08D',
                  highContrastLight: '#347433',
                },
              },
            ],
            configuration: {
                title: 'Git',
                properties: {
                    'dataverseIde.git.authorName': {
                        type: 'string',
                        default: '',
                        description:
                            'Git commit author name. Set together with authorEmail to skip the author prompts.',
                    },
                    'dataverseIde.git.authorEmail': {
                        type: 'string',
                        default: '',
                        description:
                            'Git commit author email address. Set together with authorName to skip the author prompts.',
                    },
                    'dataverseIde.git.autoFetchMinutes': {
                        'type': 'number',
                        default: 0,
                        minimum: 0,
                        description:
                            'Automatically fetch from the configured remote(s) every N minutes while the workspace is open. 0 disables auto-fetch.',
                    },
                },
            },
            commands: [
              {
                command: 'dataverseGit.initialize',
                title: 'Git: Initialize Repository',
              },
              {
                command: 'dataverseGit.refresh',
                title: 'Git: Refresh Status',
              },
              {
                command: 'dataverseGit.stage',
                title: 'Git: Stage Changes',
                icon: '$(plus)',
              },
              {
                command: 'dataverseGit.stageSelectedLines',
                title: 'Git: Stage Selected Lines',
              },
              {
                command: 'dataverseGit.discardSelectedLines',
                title: 'Git: Discard Selected Lines',
              },
              {
                command: 'dataverseGit.commitAmend',
                title: 'Git: Commit (Amend Last Commit)',
              },
              {
                command: 'dataverseGit.addToGitignore',
                title: 'Git: Add to .gitignore',
              },
              {
                command: 'dataverseGit.stageAll',
                title: 'Git: Stage All Changes',
                icon: '$(plus)',
              },
              {
                command: 'dataverseGit.unstage',
                title: 'Git: Unstage Changes',
                icon: '$(minus)',
              },
              {
                command: 'dataverseGit.unstageAll',
                title: 'Git: Unstage All Changes',
                icon: '$(minus)',
              },
              {
                command: 'dataverseGit.discard',
                title: 'Git: Discard Changes',
                icon: '$(discard)',
              },
              {
                command: 'dataverseGit.discardAll',
                title: 'Git: Discard All Changes',
                icon: '$(discard)',
              },
              {
                command: 'dataverseGit.openChanges',
                title: 'Git: Open Changes',
                icon: '$(diff)',
              },
              {
                command: 'dataverseGit.commit',
                title: 'Git: Commit Staged Changes',
              },
              {
                command: 'dataverseGit.createBranch',
                title: 'Git: Create Branch',
              },
              {
                command: 'dataverseGit.switchBranch',
                title: 'Git: Switch Branch',
              },
              {
                command: 'dataverseGit.deleteBranch',
                title: 'Git: Delete Branch',
              },
              {
                command: 'dataverseGit.showHistory',
                title: 'Git: Show Commit History',
              },
              {
                command: 'dataverseGit.showFileHistory',
                title: 'Git: Show File History (Timeline)',
              },
              {
                command: 'dataverseGit.sync',
                title: 'Git: Sync',
              },
              {
                command: 'dataverseGit.clone',
                title: 'Git: Clone Repository',
              },
              {
                command: 'dataverseGit.addRemote',
                title: 'Git: Add Remote',
              },
              {
                command: 'dataverseGit.removeRemote',
                title: 'Git: Remove Remote',
              },
              {
                command: 'dataverseGit.fetch',
                title: 'Git: Fetch',
              },
              {
                command: 'dataverseGit.pull',
                title: 'Git: Pull',
              },
              {
                command: 'dataverseGit.push',
                title: 'Git: Push',
              },
              {
                command: 'dataverseGit.forgetCredentials',
                title: 'Git: Forget Stored Remote Credentials',
              },
            ],

            submenus: [
              {
                id: 'dataverseGit.stateMenu',
                label: 'More Actions…',
              },
              {
                id: 'dataverseGit.repoMenu',
                label: 'Git: More Actions…',
                icon: '$(ellipsis)',
              },
            ],

            menus: {
              'scm/resourceState/context': [
                {
                  command: 'dataverseGit.addToGitignore',
                  when: 'scmProvider == dataverseGit && scmResourceState == untracked',
                  group: '9_ignored',
                },
                {
                  command: 'dataverseGit.openChanges',
                  when:
                    'scmProvider == dataverseGit && scmResourceState == changes || scmProvider == dataverseGit && scmResourceState == staged',
                  group: 'navigation@1',
                },
                {
                  command: 'dataverseGit.stage',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == changes && scmResourceState != untracked',
                  group: 'inline@1',
                },
                {
                  command: 'dataverseGit.unstage',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == staged',
                  group: 'inline@1',
                },
                {
                  command: 'dataverseGit.discard',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == changes',
                  group: 'inline@2',
                },
                {
                  command: 'dataverseGit.addToGitignore',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == changes && scmResourceState == untracked',
                  group: 'inline@3',
                },
                {
                  submenu: 'dataverseGit.stateMenu',
                  when: 'scmProvider == dataverseGit',
                  group: '9_more',
                },
              ],

              'scm/resourceGroup/context': [
                {
                  command: 'dataverseGit.stageAll',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == changes',
                  group: '1_modification@1',
                },
                {
                  command: 'dataverseGit.addToGitignore',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == changes && scmResourceState == untracked',
                  group: '1_modification@2',
                },
                {
                  command: 'dataverseGit.unstageAll',
                  when: 'scmProvider == dataverseGit && scmResourceGroup == staged',
                  group: '1_modification@1',
                },
                {
                  submenu: 'dataverseGit.stateMenu',
                  when: 'scmProvider == dataverseGit',
                  group: '9_more',
                },
              ],

              'dataverseGit.stateMenu': [
                {
                  command: 'dataverseGit.stageAll',
                  group: '1_modification',
                },
                {
                  command: 'dataverseGit.unstageAll',
                  group: '1_modification',
                },
                {
                  command: 'dataverseGit.discardAll',
                  group: '2_destructive',
                },
                {
                  command: 'dataverseGit.refresh',
                  group: '9_refresh',
                },
              ],

              'explorer/context': [
                {
                  command: 'dataverseGit.showFileHistory',
                  when: 'dataverseGit.isRepository',
                  group: '9_git',
                },
              ],
              'scm/title': [
                {
                  command: 'dataverseGit.initialize',
                  when: 'scmProvider == dataverseGit && !dataverseGit.isRepository',
                  group: 'navigation@1',
                },
                {
                  command: 'dataverseGit.refresh',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@1',
                },
                {
                  /*
                   * A single "…" overflow keeps the title bar uncluttered;
                   * every other Git command lives in this submenu (desktop
                   * VS Code does the same with its "…" SCM title menu).
                   */
                  submenu: 'dataverseGit.repoMenu',
                  when: 'scmProvider == dataverseGit',
                  group: 'navigation@2',
                },
              ],

              'dataverseGit.repoMenu': [
                {
                  command: 'dataverseGit.stageSelectedLines',
                  group: '0_partial',
                },
                {
                  command: 'dataverseGit.discardSelectedLines',
                  group: '0_partial',
                },
                {
                  command: 'dataverseGit.stageAll',
                  group: '1_changes',
                },
                {
                  command: 'dataverseGit.unstageAll',
                  group: '1_changes',
                },
                {
                  command: 'dataverseGit.discardAll',
                  group: '2_changes_danger',
                },
                {
                  command: 'dataverseGit.commitAmend',
                  group: '2_commit',
                },
                {
                  command: 'dataverseGit.createBranch',
                  group: '3_branch',
                },
                {
                  command: 'dataverseGit.switchBranch',
                  group: '3_branch',
                },
                {
                  command: 'dataverseGit.deleteBranch',
                  group: '3_branch',
                },
                {
                  command: 'dataverseGit.sync',
                  group: '4_remote',
                },
                {
                  command: 'dataverseGit.fetch',
                  group: '4_remote',
                },
                {
                  command: 'dataverseGit.pull',
                  group: '4_remote',
                },
                {
                  command: 'dataverseGit.push',
                  group: '4_remote',
                },
                {
                  command: 'dataverseGit.clone',
                  group: '4_remote',
                },
                {
                  command: 'dataverseGit.addRemote',
                  group: '5_remote_config',
                },
                {
                  command: 'dataverseGit.removeRemote',
                  group: '5_remote_config',
                },
                {
                  command: 'dataverseGit.forgetCredentials',
                  group: '5_remote_config',
                },
                {
                  command: 'dataverseGit.showHistory',
                  group: '6_history',
                },
                {
                  command: 'dataverseGit.showFileHistory',
                  group: '6_history',
                },
                {
                  command: 'dataverseGit.initialize',
                  group: '7_repo',
                },
              ],

          
              commandPalette: [
                {
                  command: 'dataverseGit.initialize',
                },
                {
                  command: 'dataverseGit.createBranch',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.switchBranch',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.deleteBranch',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.showHistory',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.showFileHistory',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.sync',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.stageSelectedLines',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.discardSelectedLines',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.commitAmend',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.addToGitignore',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.addRemote',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.removeRemote',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.fetch',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.pull',
                  when: 'dataverseGit.isRepository',
                },
                {
                  command: 'dataverseGit.push',
                  when: 'dataverseGit.isRepository',
                },
              ],
            },
          },
      } as unknown as IExtensionManifest,
      ExtensionHostKind.LocalProcess,
    )
  
    const vscode = await getApi()
  
    const sourceControl = vscode.scm.createSourceControl(
      'dataverseGit',
      'Git',
      rootUri,
    )
  
    const changesGroup = sourceControl.createResourceGroup(
      'changes',
      'Changes',
    )
  
    const stagedGroup = sourceControl.createResourceGroup(
      'staged',
      'Staged Changes',
    )
  
    sourceControl.inputBox.placeholder =
    'Enter a commit message to commit staged changes.'

    /*
     * Mirror desktop VS Code: changed files get colored letter badges in the
     * File Explorer. The provider reads a cached status map that refresh()
     * keeps in sync with the Git index snapshot.
     */
    const decorationEmitter = new vscode.EventEmitter<
      vscodeType.Uri[] | undefined
    >()

    const decorationStatuses = new Map<string, GitFileStatus>()

    const fileDecorationProvider = vscode.window.registerFileDecorationProvider(
      {
        onDidChangeFileDecorations: decorationEmitter.event,

        provideFileDecoration(uri) {
          const rootPath = rootUri.path.replace(/\/+$/, '')

          if (uri.scheme !== rootUri.scheme) {
            return undefined
          }

          const uriPath = uri.path.replace(/\/+$/, '')

          if (uriPath.length < rootPath.length || !uriPath.startsWith(rootPath)) {
            return undefined
          }

          if (uriPath === rootPath) {
            // The workspace root: badges are not shown on the root in VS Code.
            return undefined
          }

          const relativePath = uriPath.slice(rootPath.length + 1)

          const ownStatus = decorationStatuses.get(relativePath)

          if (ownStatus != null) {
            const decoration = getExplorerDecoration(ownStatus)

            if (decoration == null) {
              return undefined
            }

            return {
              badge: decoration.badge,
              color: new vscode.ThemeColor(decoration.colorId),
              tooltip: getStatusTooltip(ownStatus),

              /*
               * Also lets the Explorer bubble child states up onto parent
               * folders when it supports that path.
               */
              propagate: true,
            }
          }

          /*
           * Decorate folders with the most severe status among their
           * descendants (like desktop VS Code shows folder badges).
           */
          const folderPrefix = `${relativePath}/`

          for (const [path, status] of decorationStatuses) {
            if (path.startsWith(folderPrefix)) {
              const decoration = getExplorerDecoration(status)

              if (decoration != null) {
                return {
                  badge: decoration.badge,
                  color: new vscode.ThemeColor(decoration.colorId),
                  tooltip: getStatusTooltip(status),
                  propagate: true,
                }
              }
            }
          }

          return undefined
        },
      },
    )

    /*
     * Read-only blob content for "open revision" documents opened from file
     * history (the timeline replacement — see dataverseGit.showFileHistory).
     */
    const historyScheme = 'dataverse-git-history'

    const historyContentProvider =
      vscode.workspace.registerTextDocumentContentProvider(historyScheme, {
        async provideTextDocumentContent(uri: vscodeType.Uri) {
          const params = new URLSearchParams(uri.query)

          const oid = params.get('oid') ?? ''
          const path = params.get('path') ?? ''

          if (oid.length === 0 || path.length === 0) {
            return ''
          }

          const blob = await readBlobAt(workspaceHandle, oid, path)

          if (blob == null) {
            return ''
          }

          return new TextDecoder().decode(blob)
        },
      })

    const fileDecorationRefresh = (): void => {
      decorationEmitter.fire(undefined)
    }
  
    let refreshTimer: number | undefined
    let refreshInProgress = false
    let refreshQueued = false
  
    async function refresh(): Promise<void> {
      if (refreshInProgress) {
        refreshQueued = true
        return
      }
  
      refreshInProgress = true
  
      try {
        const snapshot = await getGitRepositorySnapshot(workspaceHandle)

        await vscode.commands.executeCommand(
            'setContext',
            'dataverseGit.isRepository',
            snapshot.isRepository,
          )
  
        if (!snapshot.isRepository) {
          sourceControl.count = 0
          changesGroup.resourceStates = []
          stagedGroup.resourceStates = []

          decorationStatuses.clear()
          fileDecorationRefresh()

          sourceControl.statusBarCommands = [
            {
              command: 'dataverseGit.initialize',
              title: '$(source-control) Initialize Repository',
              tooltip: 'Initialize a Git repository in this workspace',
            },
          ]

          sourceControl.inputBox.placeholder =
  'Initialize a Git repository to enable commits.'
  
          return
        }
  
        sourceControl.inputBox.placeholder =
        snapshot.head == null
          ? 'Stage files and enter an initial commit message.'
          : 'Enter a commit message to commit staged changes.'

        /*
         * A file modified after staging appears in both groups, which matches
         * normal Git/VS Code behavior: one version is staged and another remains
         * modified in the working tree.
         */
        const changedEntries = snapshot.entries.filter(
          (entry) =>
            entry.changed ||
            entry.status === 'untracked' ||
            entry.status === 'deleted',
        )
  
        const stagedEntries = snapshot.entries.filter(
          (entry) => entry.staged,
        )
  
        changesGroup.resourceStates = changedEntries.map((entry) =>
        createResourceState(
          vscode,
          rootUri,
          entry,
          'changes',
        ),
      )
      
      stagedGroup.resourceStates = stagedEntries.map((entry) =>
        createResourceState(
          vscode,
          rootUri,
          entry,
          'staged',
        ),
      )
  
        sourceControl.count =
          changesGroup.resourceStates.length +
          stagedGroup.resourceStates.length

        /*
         * Keep the Explorer decoration cache in sync with the index snapshot.
         */
        decorationStatuses.clear()

        for (const entry of new Map(
          changedEntries.map((entry) => [entry.path, entry.status]),
        )) {
          decorationStatuses.set(entry[0], entry[1])
        }

        for (const entry of stagedEntries) {
          /*
           * Staged-only states that are no longer modified in the worktree are
           * still worth showing in Explorer (the file differs from HEAD).
           */
          if (!decorationStatuses.has(entry.path)) {
            if (entry.status === 'modified-and-staged') {
              decorationStatuses.set(
                entry.path,
                'modified-and-staged',
              )
            } else if (entry.status === 'added' || entry.status === 'deleted-and-staged') {
              decorationStatuses.set(entry.path, entry.status)
            }
          }
        }

        fileDecorationRefresh()

        const branchLabel = snapshot.branch ?? 'DETACHED'

        /*
         * Sync status (ahead/behind vs upstream), like desktop VS Code's
         * "N↓ M↑" SCM status bar item.
         */
        let sync: Awaited<ReturnType<typeof getSyncStatus>> | undefined

        try {
          sync = await getSyncStatus(workspaceHandle)
        } catch (syncError) {
          console.warn(
            '[Dataverse IDE] Unable to compute Git sync status.',
            syncError,
          )
        }

        const statusBarCommands: Array<{
          command: string
          title: string
          tooltip?: string
        }> = [
          {
            command: 'dataverseGit.switchBranch',
            title: `$(git-branch) ${branchLabel}`,
            tooltip: 'Switch Git branch',
          },
        ]

        if (sync != null && sync.upstream != null) {
          const aheadUp = sync.ahead > 0 ? `${sync.ahead}↑ ` : ''
          const behindDown = sync.behind > 0 ? `${sync.behind}↓ ` : ''

          const counts = `${behindDown}${aheadUp}`.trim()

          /*
           * Enrich the tooltip with the remote URL and how long ago the
           * last fetch/pull happened (desktop shows fetch age too).
           */
          let syncDetails = ''

          try {
            const remotes = await listRemotes(workspaceHandle)
            const upstreamRemote = sync.upstream.replace('refs/remotes/', '').split('/')[0]

            const remoteUrl = remotes.find(
              (remote) => remote.name === upstreamRemote,
            )?.url

            if (remoteUrl != null) {
              syncDetails += ` — ${remoteUrl}`
            }
          } catch {
            /* no remotes: tooltip simply lacks the URL */
          }

          if (metadataStore != null) {
            try {
              const lastFetchValue = await metadataStore.get(LAST_FETCH_KEY)

              if (lastFetchValue != null && lastFetchValue.length > 0) {
                const lastFetchMs = Date.parse(lastFetchValue)

                if (!Number.isNaN(lastFetchMs)) {
                  const minutes = Math.floor(
                    (Date.now() - lastFetchMs) / 60000,
                  )

                  syncDetails +=
                    minutes < 1
                      ? ' — fetched just now'
                      : minutes < 60
                        ? ` — last fetch ${minutes} min ago`
                        : ` — last fetch ${Math.floor(minutes / 60)} h ago`
                }
              }
            } catch {
              /* skip fetch-age display on metadata store failure */
            }
          }

          statusBarCommands.unshift({
            command: 'dataverseGit.sync',
            title:
              counts.length > 0 ? `$(sync) ${counts}` : '$(sync) 0↓ 0↑',
            tooltip:
              sync.ahead === 0 && sync.behind === 0
                ? `${branchLabel} is up to date with ${sync.upstream.replace('refs/remotes/', '')}${syncDetails}`
                : `${sync.behind} commits behind, ${sync.ahead} ahead of ${sync.upstream.replace('refs/remotes/', '')}${syncDetails}`,
          })
        }

        statusBarCommands.push({
          command: 'dataverseGit.refresh',
          title: '$(refresh)',
          tooltip: 'Refresh Git status',
        })

        sourceControl.statusBarCommands = statusBarCommands
      } catch (error) {
        console.error(
          '[Dataverse IDE] Unable to refresh Git status.',
          error,
        )
  
        sourceControl.statusBarCommands = [
          {
            command: 'dataverseGit.refresh',
            title: '$(warning) Git Status Error',
            tooltip: 'Open DevTools for Git error details',
          },
        ]
      } finally {
        refreshInProgress = false
  
        if (refreshQueued) {
          refreshQueued = false
          void refresh()
        }
      }
    }
  
    function scheduleRefresh(delayMs = 350): void {
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer)
      }
  
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void refresh()
      }, delayMs)
    }
  
    function getFilepathFromCommandArgument(
        argument: unknown,
      ): string | undefined {
        /*
         * Source Control context-menu commands normally receive the selected
         * SourceControlResourceState, but support a Uri too for flexibility.
         */
        const possibleUri =
          typeof argument === 'object' &&
          argument != null &&
          'resourceUri' in argument
            ? (argument as { resourceUri?: vscodeType.Uri }).resourceUri
            : argument
      
        if (
          typeof possibleUri !== 'object' ||
          possibleUri == null ||
          !('path' in possibleUri) ||
          typeof (possibleUri as { path?: unknown }).path !== 'string'
        ) {
          return undefined
        }
      
        const relativePath = vscode.workspace.asRelativePath(
          possibleUri as vscodeType.Uri,
          false,
        )
      
        if (
          relativePath.length === 0 ||
          relativePath.startsWith('../') ||
          relativePath.startsWith('..\\')
        ) {
          return undefined
        }
      
        return relativePath.replaceAll('\\', '/')
      }
      
      async function getCommitAuthor(): Promise<
        | {
            name: string
            email: string
          }
        | undefined
      > {
        /*
         * Settings panel values (dataverseIde.git.authorName/authorEmail)
         * skip the prompts when both are set.
         */
        const config = vscode.workspace.getConfiguration(
          'dataverseIde.git',
          rootUri,
        )

        const configuredName =
          config.get<string>('authorName', '').trim()
        const configuredEmail =
          config.get<string>('authorEmail', '').trim()

        if (configuredName.length > 0 && configuredEmail.length > 0) {
          return {
            name: configuredName,
            email: configuredEmail,
          }
        }

        const name = await vscode.window.showInputBox({
          title: 'Git Commit Author',
          prompt: 'Enter the commit author name.',
          placeHolder: 'Example: Ada Lovelace',
          value: configuredName.length > 0 ? configuredName : undefined,
          ignoreFocusOut: true,
        })
      
        if (name == null || name.trim().length === 0) {
          return undefined
        }
      
        const email = await vscode.window.showInputBox({
          title: 'Git Commit Author',
          prompt: 'Enter the commit author email address.',
          placeHolder: 'Example: ada@example.mil',
          value: configuredEmail.length > 0 ? configuredEmail : undefined,
          ignoreFocusOut: true,
        })
      
        if (email == null || email.trim().length === 0) {
          return undefined
        }
      
        return {
          name: name.trim(),
          email: email.trim(),
        }
      }

      const refreshCommand = vscode.commands.registerCommand(
        'dataverseGit.refresh',
        async () => {
          await refresh()
        },
      )
      
      const stageCommand = vscode.commands.registerCommand(
        'dataverseGit.stage',
        async (resourceState: unknown) => {
          const filepath = getFilepathFromCommandArgument(resourceState)
      
          if (filepath == null) {
            await vscode.window.showWarningMessage(
              'Select a file in the Changes group to stage it.',
            )
      
            return
          }
      
          try {
            await stagePaths(workspaceHandle, [filepath])
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git stage failed.', error)
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to stage file: ${error.message}`
                : 'Unable to stage file.',
            )
          }
        },
      )
      
      const stageAllCommand = vscode.commands.registerCommand(
        'dataverseGit.stageAll',
        async () => {
          try {
            await stageAll(workspaceHandle)
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git stage-all failed.', error)
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to stage changes: ${error.message}`
                : 'Unable to stage changes.',
            )
          }
        },
      )
      
      const unstageCommand = vscode.commands.registerCommand(
        'dataverseGit.unstage',
        async (resourceState: unknown) => {
          const filepath = getFilepathFromCommandArgument(resourceState)
      
          if (filepath == null) {
            await vscode.window.showWarningMessage(
              'Select a file in the Staged Changes group to unstage it.',
            )
      
            return
          }
      
          try {
            await unstagePaths(workspaceHandle, [filepath])
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git unstage failed.', error)
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to unstage file: ${error.message}`
                : 'Unable to unstage file.',
            )
          }
        },
      )
      
      const unstageAllCommand = vscode.commands.registerCommand(
        'dataverseGit.unstageAll',
        async () => {
          try {
            await unstageAll(workspaceHandle)
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git unstage-all failed.', error)
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to unstage changes: ${error.message}`
                : 'Unable to unstage changes.',
            )
          }
        },
      )
      
      const discardCommand = vscode.commands.registerCommand(
        'dataverseGit.discard',
        async (resourceState: unknown) => {
          const filepath = getFilepathFromCommandArgument(resourceState)

          if (filepath == null) {
            await vscode.window.showWarningMessage(
              'Select a file in the Changes group to discard its changes.',
            )

            return
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Are you sure you want to discard changes in ${filepath}?`,
            {
              modal: true,
            },
            'Discard Changes',
          )

          if (confirmation !== 'Discard Changes') {
            return
          }

          try {
            await discardPaths(workspaceHandle, [filepath])
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git discard failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to discard changes: ${error.message}`
                : 'Unable to discard changes.',
            )
          }
        },
      )

      const discardAllCommand = vscode.commands.registerCommand(
        'dataverseGit.discardAll',
        async () => {
          try {
            const snapshot = await getGitRepositorySnapshot(workspaceHandle)

            const paths = snapshot.entries
              .filter((entry) => entry.changed)
              .map((entry) => entry.path)

            if (paths.length === 0) {
              await vscode.window.showInformationMessage(
                'There are no working-tree changes to discard.',
              )

              return
            }

            const confirmation = await vscode.window.showWarningMessage(
              `Are you sure you want to discard changes in ${paths.length} file${paths.length === 1 ? '' : 's'}?`,
              {
                modal: true,
              },
              'Discard All Changes',
            )

            if (confirmation !== 'Discard All Changes') {
              return
            }

            await discardPaths(workspaceHandle, paths)
            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Git discard-all failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to discard changes: ${error.message}`
                : 'Unable to discard changes.',
            )
          }
        },
      )

      /*
       * Desktop-style "Open Changes": a read-only diff of the file as it was
       * in the (staged) HEAD revision against the current working tree.
       */
      const openChangesCommand = vscode.commands.registerCommand(
        'dataverseGit.openChanges',
        async (resourceState: unknown) => {
          try {
            const filepath = getFilepathFromCommandArgument(resourceState)

            if (filepath == null) {
              await vscode.window.showWarningMessage(
                'Select a changed file to open its diff.',
              )

              return
            }

            const headCommit = await getHeadCommit(workspaceHandle)

            if (headCommit == null) {
              await vscode.window.showInformationMessage(
                'This file has no committed version yet.',
              )

              return
            }

            const originalUri = vscode.Uri.from({
              scheme: historyScheme,
              path: `/${filepath.split('/').pop() ?? filepath}`,
              query: `oid=${headCommit}&path=${encodeURIComponent(filepath)}`,
            })

            const modifiedUri = toResourceUri(
              vscode,
              rootUri,
              filepath,
            )

            const shortLabel = filepath.split('/').pop() ?? filepath

            await vscode.commands.executeCommand(
              'vscode.diff',
              originalUri,
              modifiedUri,
              `${shortLabel} (Working Tree)`,
            )
          } catch (error) {
            console.error('[Dataverse IDE] Git diff failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to open changes: ${error.message}`
                : 'Unable to open changes.',
            )
          }
        },
      )

      /*
       * Commit from the SCM input box. With an empty message, offer recent
       * commit messages as a starting point (message history, like desktop).
       */
      async function requestCommitMessage(): Promise<
        string | undefined
      > {
        const typed = sourceControl.inputBox.value.trim()

        if (typed.length > 0) {
          return typed
        }

        const recent = await getRecentCommits(workspaceHandle, 20)

        if (
          recent.length === 0 ||
          !recent.every((commit) => commit.message.length > 0)
        ) {
          await vscode.window.showWarningMessage(
            'Enter a commit message before committing.',
          )

          return undefined
        }

        const selected = await vscode.window.showQuickPick(
          recent
            .filter(
              (commit, index, all) =>
                all.findIndex(
                  (other) => other.message === commit.message,
                ) === index,
            )
            .map((commit) => ({
              label: `$(history) ${commit.message.split('\n')[0]}`,
              detail: `${commit.oid.slice(0, 8)} · ${new Date(
                commit.timestamp * 1000,
              ).toLocaleDateString()}`,
            })),
          {
            title: 'Recent Commit Messages',
            placeHolder:
              'No message typed — pick a recent one to reuse.',
          },
        )

        if (selected == null) {
          return undefined
        }

        const reused = selected.label.replace(/^\$\(history\)\s*/, '')
        sourceControl.inputBox.value = reused
        return reused
      }

      const commitCommand = vscode.commands.registerCommand(
        'dataverseGit.commit',
        async () => {
          const message = await requestCommitMessage()

          if (message == null) {
            return
          }

          const author = await getCommitAuthor()

          if (author == null) {
            return
          }

          try {
            const commitId = await createCommit(workspaceHandle, {
              message,
              author,
            })

            sourceControl.inputBox.value = ''

            await refresh()

            await vscode.window.showInformationMessage(
              `Created commit ${commitId.slice(0, 8)}.`,
            )
          } catch (error) {
            console.error('[Dataverse IDE] Git commit failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to create commit: ${error.message}`
                : 'Unable to create commit.',
            )
          }
        },
      )

      const commitAmendCommand = vscode.commands.registerCommand(
        'dataverseGit.commitAmend',
        async () => {
          try {
            const lastCommit = (await getRecentCommits(
              workspaceHandle,
              1,
            ))[0]

            const message = await vscode.window.showInputBox({
              title: 'Amend Last Commit',
              prompt:
                'Update the message of the last commit (staged changes are folded into it).',
              value: lastCommit?.message ?? undefined,
              ignoreFocusOut: true,
            })

            if (message == null || message.trim().length === 0) {
              return
            }

            const author = await getCommitAuthor()

            if (author == null) {
              return
            }

            const commitId = await createCommit(workspaceHandle, {
              message,
              author,
              amend: true,
            })

            sourceControl.inputBox.value = ''

            await refresh()

            await vscode.window.showInformationMessage(
              `Amended into ${commitId.slice(0, 8)}.`,
            )
          } catch (error) {
            console.error('[Dataverse IDE] Git amend failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to amend commit: ${error.message}`
                : 'Unable to amend commit.',
            )
          }
        },
      )

      /*
       * Inline editor actions: stage (or discard) exactly the selected lines.
       * Implemented by diffing the selected file against HEAD and writing a
       * merged copy through the index while keeping the working tree intact.
       */
      type PartialLineTarget = {
        filepath: string
        baseText: string
        currentText: string
        selection: { fromInclusive: number; toInclusive: number }
      }

      async function resolvePartialLineTarget(): Promise<
        PartialLineTarget | undefined
      > {
        const editor = vscode.window.activeTextEditor

        if (editor == null) {
          await vscode.window.showWarningMessage(
            'Open a changed file and select its lines first.',
          )

          return undefined
        }

        const filepath = getFilepathFromCommandArgument(editor.document.uri)

        if (filepath == null) {
          return undefined
        }

        const document = editor.document

        if (document.isDirty) {
          await document.save()
        }

        const headCommit = await getHeadCommit(workspaceHandle)

        const baseBlob =
          headCommit != null
            ? await readBlobAt(workspaceHandle, headCommit, filepath)
            : undefined

        const currentText = document.getText()

        return {
          filepath,
          baseText: baseBlob != null ? new TextDecoder().decode(baseBlob) : '',
          currentText,
          selection: {
            fromInclusive: editor.selection.start.line,
            toInclusive: editor.selection.end.line,
          },
        }
      }

      function detectEol(text: string): string {
        return text.includes('\r\n') ? '\r\n' : '\n'
      }

      const stageSelectedLinesCommand = vscode.commands.registerCommand(
        'dataverseGit.stageSelectedLines',
        async () => {
          try {
            const target = await resolvePartialLineTarget()

            if (target == null) {
              return
            }

            const replacements = detectLineDiff(
              target.baseText,
              target.currentText,
            )

            if (replacements.length === 0) {
              await vscode.window.showInformationMessage(
                `"${target.filepath}" has no changes relative to HEAD.`,
              )

              return
            }

            const stagedContent = selectiveMerge(
              splitLines(target.baseText),
              splitLines(target.currentText),
              replacements,
              detectEol(target.currentText),
              target.selection,
              'selected',
            )

            if (stagedContent === target.baseText) {
              await vscode.window.showInformationMessage(
                'The selection contains no changes to stage.',
              )

              return
            }

            const encoder = new TextEncoder()

            await stageExactContent(
              workspaceHandle,
              target.filepath,
              encoder.encode(stagedContent),
              encoder.encode(target.currentText),
            )

            await refresh()

            await vscode.window.showInformationMessage(
              'Staged the selected lines.',
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Partial staging failed.',
              error,
            )

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to stage selected lines: ${error.message}`
                : 'Unable to stage selected lines.',
            )
          }
        },
      )

      const discardSelectedLinesCommand = vscode.commands.registerCommand(
        'dataverseGit.discardSelectedLines',
        async () => {
          try {
            const target = await resolvePartialLineTarget()

            if (target == null) {
              return
            }

            const replacements = detectLineDiff(
              target.baseText,
              target.currentText,
            )

            if (replacements.length === 0) {
              await vscode.window.showInformationMessage(
                `"${target.filepath}" has no changes relative to HEAD.`,
              )

              return
            }

            const restoredContent = selectiveMerge(
              splitLines(target.baseText),
              splitLines(target.currentText),
              replacements,
              detectEol(target.currentText),
              target.selection,
              'unselected',
            )

            if (restoredContent === target.currentText) {
              await vscode.window.showInformationMessage(
                'The selection contains no changes to discard.',
              )

              return
            }

            const confirmation = await vscode.window.showWarningMessage(
              'Discard the selected changes? This cannot be undone.',
              {
                modal: true,
              },
              'Discard Selected Lines',
            )

            if (confirmation !== 'Discard Selected Lines') {
              return
            }

            /*
             * Applying through the open editor keeps the text model, the
             * working tree, and file-change tracking in sync; then a save
             * updates the quick diff gutter.
             */
            const editor = vscode.window.activeTextEditor

            if (editor != null) {
              const firstPosition = editor.document.positionAt(0)
              const lastPosition = editor.document.positionAt(
                editor.document.getText().length,
              )

              await editor.edit((builder) =>
                builder.replace(
                  new vscode.Range(firstPosition, lastPosition),
                  restoredContent,
                ),
              )

              await editor.document.save()
            } else {
              await writeWorkdirFile(
                workspaceHandle,
                target.filepath,
                new TextEncoder().encode(restoredContent),
              )
            }

            await refresh()

            await vscode.window.showInformationMessage(
              'Discarded the selected changes.',
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Partial discard failed.',
              error,
            )

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to discard selected lines: ${error.message}`
                : 'Unable to discard selected lines.',
            )
          }
        },
      )

      const addToGitignoreCommand = vscode.commands.registerCommand(
        'dataverseGit.addToGitignore',
        async (resourceState: unknown) => {
          try {
            const filepath = getFilepathFromCommandArgument(resourceState)

            if (filepath == null) {
              await vscode.window.showWarningMessage(
                'Select an untracked file to add it to .gitignore.',
              )

              return
            }

            const encoder = new TextEncoder()
            const decoder = new TextDecoder()

            const existingBytes = await readWorkdirFile(
              workspaceHandle,
              '.gitignore',
            )

            const existing = existingBytes != null
              ? decoder.decode(existingBytes)
              : ''

            const ignoreLine = filepath.startsWith('/') ? filepath : `/${filepath}`

            const alreadyIgnored = existing
              .split(/\r?\n/)
              .some(
                (line) =>
                  line.trim() === ignoreLine.trim() ||
                  line.trim() === filepath,
              )

            if (alreadyIgnored) {
              await vscode.window.showInformationMessage(
                `"${filepath}" is already ignored.`,
              )

              return
            }

            const separator =
              existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
            const additionBlock =
              existing.length === 0
                ? `${ignoreLine}\n`
                : `${separator}${ignoreLine}\n`

            const confirmation = await vscode.window.showInformationMessage(
              `Add "${filepath}" to .gitignore?`,
              {
                modal: false,
              },
              'Add to .gitignore',
            )

            if (confirmation !== 'Add to .gitignore') {
              return
            }

            await writeWorkdirFile(
              workspaceHandle,
              '.gitignore',
              encoder.encode(`${existing}${additionBlock}`),
            )

            await refresh()
          } catch (error) {
            console.error('[Dataverse IDE] Add-to-gitignore failed.', error)

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to update .gitignore: ${error.message}`
                : 'Unable to update .gitignore.',
            )
          }
        },
      )

      const initializeCommand = vscode.commands.registerCommand(
        'dataverseGit.initialize',
        async () => {
          const initialBranch = await vscode.window.showInputBox({
            title: 'Initialize Git Repository',
            prompt: 'Enter the initial branch name.',
            value: 'main',
            ignoreFocusOut: true,
            validateInput(value) {
              if (value.trim().length === 0) {
                return 'An initial branch name is required.'
              }
      
              return undefined
            },
          })
      
          if (initialBranch == null) {
            return
          }
      
          const confirmation = await vscode.window.showWarningMessage(
            `Initialize a Git repository in this workspace using branch "${initialBranch.trim()}"?`,
            {
              modal: true,
            },
            'Initialize Repository',
          )
      
          if (confirmation !== 'Initialize Repository') {
            return
          }
      
          try {
            await initializeRepository(
              workspaceHandle,
              initialBranch,
            )
      
            await refresh()
      
            await vscode.window.showInformationMessage(
              `Initialized Git repository on branch "${initialBranch.trim()}".`,
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git initialization failed.',
              error,
            )
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to initialize Git repository: ${error.message}`
                : 'Unable to initialize Git repository.',
            )
          }
        },
      )
      
      const createBranchCommand = vscode.commands.registerCommand(
        'dataverseGit.createBranch',
        async () => {
          const branchName = await vscode.window.showInputBox({
            title: 'Create Git Branch',
            prompt: 'Enter the name of the new branch.',
            placeHolder: 'feature/my-change',
            ignoreFocusOut: true,
          })
      
          if (branchName == null) {
            return
          }
      
          const checkoutChoice = await vscode.window.showQuickPick(
            [
              {
                label: 'Create and switch to branch',
                checkout: true,
              },
              {
                label: 'Create branch only',
                checkout: false,
              },
            ],
            {
              title: 'Create Git Branch',
              placeHolder: 'Choose what to do after branch creation.',
              ignoreFocusOut: true,
            },
          )
      
          if (checkoutChoice == null) {
            return
          }
      
          try {
            await createBranch(
              workspaceHandle,
              branchName,
              {
                checkout: checkoutChoice.checkout,
              },
            )
      
            await refresh()
      
            await vscode.window.showInformationMessage(
              checkoutChoice.checkout
                ? `Created and switched to "${branchName.trim()}".`
                : `Created branch "${branchName.trim()}".`,
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git branch creation failed.',
              error,
            )
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to create branch: ${error.message}`
                : 'Unable to create branch.',
            )
          }
        },
      )
      
      const switchBranchCommand = vscode.commands.registerCommand(
        'dataverseGit.switchBranch',
        async () => {
          try {
            const branches = await listLocalBranches(workspaceHandle)

            if (branches.length === 0) {
              await vscode.window.showWarningMessage(
                'Create an initial commit before switching branches.',
              )

              return
            }

            /*
             * Remote-tracking branches (from the last fetch) are also
             * offered; picking one creates a local branch at that commit
             * and checks it out, like desktop VS Code.
             */
            type BranchPick = {
              label: string
              description?: string
              current?: boolean
              remote?: {
                remoteName: string
                branchName: string
              }
              localBranchName?: string
            }

            const currentBranchName = branches.find(
              (branch) => branch.current,
            )?.name

            const localOptions: BranchPick[] = branches.map((branch) => ({
              label: branch.name,
              description: branch.current ? 'Current branch' : undefined,
              current: branch.current,
              localBranchName: branch.name,
            }))

            const remotes = await listRemotes(workspaceHandle)

            const remoteOptions: BranchPick[] = (
              await Promise.all(
                remotes.map(async (remote) => {
                  const names = await listRemoteBranches(
                    workspaceHandle,
                    remote.name,
                  )

                  return names
                    .filter(
                      (name) => name !== currentBranchName,
                    )
                    .map((name) => ({
                      label: `$(cloud) ${remote.name}/${name}`,
                      description: `${remote.name} — create local branch`,
                      remote: {
                        remoteName: remote.name,
                        branchName: name,
                      },
                    }))
                }),
              )
            ).flat()

            const selected = await vscode.window.showQuickPick<BranchPick>(
              [...localOptions, ...remoteOptions],
              {
                title: 'Switch Git Branch',
                placeHolder:
                  'Select a local branch, or a remote branch to create a local one.',
                ignoreFocusOut: true,
              },
            )

            if (selected == null || selected.current) {
              return
            }

            if (selected.remote != null) {
              const localNameInput = await vscode.window.showInputBox({
                title: 'Create Local Branch From Remote',
                prompt: `Create a local branch from ${selected.remote.remoteName}/${selected.remote.branchName} and switch to it.`,
                value: selected.remote.branchName,
                ignoreFocusOut: true,
              })

              if (localNameInput == null || localNameInput.trim().length === 0) {
                return
              }

              const localName = localNameInput.trim()

              await createBranchFrom(
                workspaceHandle,
                localName,
                `refs/remotes/${selected.remote.remoteName}/${selected.remote.branchName}`,
                {
                  checkout: true,
                },
              )

              await refresh()

              await vscode.window.showInformationMessage(
                `Created and switched to "${localName}" (from ${selected.remote.remoteName}/${selected.remote.branchName}).`,
              )

              return
            }

            if (selected.localBranchName == null) {
              return
            }

            await switchBranch(workspaceHandle, selected.localBranchName)

            await refresh()

            await vscode.window.showInformationMessage(
              `Switched to "${selected.localBranchName}".`,
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git branch switch failed.',
              error,
            )

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to switch branch: ${error.message}`
                : 'Unable to switch branch.',
            )
          }
        },
      )
      
      const deleteBranchCommand = vscode.commands.registerCommand(
        'dataverseGit.deleteBranch',
        async () => {
          try {
            const branches = await listLocalBranches(workspaceHandle)
      
            const candidates = branches.filter(
              (branch) => !branch.current,
            )
      
            if (candidates.length === 0) {
              await vscode.window.showWarningMessage(
                'There are no non-current local branches to delete.',
              )
      
              return
            }
      
            const selected = await vscode.window.showQuickPick(
              candidates.map((branch) => ({
                label: branch.name,
                branch,
              })),
              {
                title: 'Delete Local Git Branch',
                placeHolder: 'Select a branch to delete.',
                ignoreFocusOut: true,
              },
            )
      
            if (selected == null) {
              return
            }
      
            const confirmation = await vscode.window.showWarningMessage(
              `Delete local branch "${selected.branch.name}"?`,
              {
                modal: true,
              },
              'Delete Branch',
            )
      
            if (confirmation !== 'Delete Branch') {
              return
            }
      
            await deleteLocalBranch(
              workspaceHandle,
              selected.branch.name,
            )
      
            await refresh()
      
            await vscode.window.showInformationMessage(
              `Deleted local branch "${selected.branch.name}".`,
            )
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git branch deletion failed.',
              error,
            )
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to delete branch: ${error.message}`
                : 'Unable to delete branch.',
            )
          }
        },
      )
      
      const showHistoryCommand = vscode.commands.registerCommand(
        'dataverseGit.showHistory',
        async () => {
          try {
            const commits = await getRecentCommits(
              workspaceHandle,
              25,
            )
      
            if (commits.length === 0) {
              await vscode.window.showInformationMessage(
                'This repository has no commits yet.',
              )
      
              return
            }
      
            /*
             * Enter re-uses the message in the commit input box (recent
             * history flow). Then a follow-up menu lets the user check the
             * commit out (detached, like desktop "Checkout Commit").
             */
            const selected = await vscode.window.showQuickPick(
              commits.map((commit) => ({
                label: `$(git-commit) ${commit.message.split('\n')[0]}`,
                description: `${commit.oid.slice(0, 8)} · ${commit.authorName}`,
                detail: `${new Date(commit.timestamp * 1000).toLocaleString()}${
                  commit.message.includes('\n')
                    ? ` — ${commit.message.split('\n').slice(1).join(' ').trim()}`
                    : ''
                }`,
                commitOid: commit.oid,
                commitMessage: commit.message,
              })),
              {
                title: 'Git Commit History',
                placeHolder:
                  'Select a commit to reuse its message or act on it.',
                ignoreFocusOut: true,
              },
            )

            if (selected == null) {
              return
            }

            if (selected.commitMessage != null) {
              sourceControl.inputBox.value = selected.commitMessage
            }

            const action = await vscode.window.showQuickPick(
              [
                {
                  label: '$(git-branch) Checkout Commit',
                  description:
                    'Detached HEAD checkout — requires a clean working tree',
                  action: 'checkout',
                },
                {
                  label: '$(copy) Copy Commit Object Name',
                  action: 'copy',
                },
              ],
              {
                title: `Commit ${selected.commitOid.slice(0, 8)}`,
                placeHolder: 'Choose an action for this commit.',
              },
            )

            if (action == null) {
              return
            }

            if (action.action === 'copy') {
              await vscode.env.clipboard.writeText(selected.commitOid)
              await vscode.window.showInformationMessage(
                `Copied ${selected.commitOid.slice(0, 8)}.`,
              )

              return
            }

            const confirmation = await vscode.window.showWarningMessage(
              `Checkout commit ${selected.commitOid.slice(0, 8)}? Requires a clean working tree.`,
              {
                modal: true,
              },
              'Checkout Commit',
            )

            if (confirmation !== 'Checkout Commit') {
              return
            }

            try {
              await checkoutCommit(workspaceHandle, selected.commitOid)
              await refresh()

              await vscode.window.showInformationMessage(
                `Checked out ${selected.commitOid.slice(0, 8)} (detached HEAD).`,
              )
            } catch (checkoutError) {
              console.error(
                '[Dataverse IDE] Git commit checkout failed.',
                checkoutError,
              )

              await vscode.window.showErrorMessage(
                checkoutError instanceof Error
                  ? `Unable to checkout commit: ${checkoutError.message}`
                  : 'Unable to checkout commit.',
              )
            }
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git history lookup failed.',
              error,
            )
      
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to read Git history: ${error.message}`
                : 'Unable to read Git history.',
            )
          }
        },
      )
      
      /*
       * Timeline: per-file commit history for the active editor (or an
       * explicitly selected resource). Clicking an entry opens a read-only
       * view of the file content at that revision, like desktop VS Code's
       * Timeline view / "Open Revision".
       */
      async function openRevision(
        filepath: string,
        commit: GitCommitSummaryLike,
      ): Promise<void> {
        const revisionUri = vscode.Uri.from({
          scheme: historyScheme,
          path: `/${filepath.split('/').pop() ?? filepath}`,
          query: `oid=${commit.oid}&path=${encodeURIComponent(filepath)}`,
        })

        await vscode.window.showTextDocument(revisionUri, {
          preview: true,
          viewColumn: vscode.ViewColumn.Active,
        })
      }

      type GitCommitSummaryLike = {
        oid: string
        message: string
        authorName: string
        authorEmail: string
        timestamp: number
      }

      const showFileHistoryCommand = vscode.commands.registerCommand(
        'dataverseGit.showFileHistory',
        async (resourceState: unknown) => {
          try {
            /*
             * Prefer the resource clicked with "Git: Show File History"
             * (e.g. from the Explorer context menu), falling back to the
             * active editor — the same fallback the Timeline uses.
             */
            let filepath = getFilepathFromCommandArgument(resourceState)

            if (filepath == null) {
              const activeEditor = vscode.window.activeTextEditor

              if (activeEditor != null) {
                filepath = getFilepathFromCommandArgument(
                  activeEditor.document.uri,
                )
              }
            }

            if (filepath == null) {
              await vscode.window.showWarningMessage(
                'Open a file (or select one in the Explorer) to show its commit history.',
              )

              return
            }

            const commits = await getRecentCommits(
              workspaceHandle,
              200,
              { filepath },
            )

            if (commits.length === 0) {
              await vscode.window.showInformationMessage(
                `"${filepath}" has no commit history yet.`,
              )

              return
            }

            const selected = await vscode.window.showQuickPick(
              commits.map((commit) => ({
                label: `$(git-commit) ${commit.message.split('\n')[0]}`,
                description: `${commit.oid.slice(0, 8)}  ·  ${commit.authorName}`,
                detail: new Date(
                  commit.timestamp * 1000,
                ).toLocaleString(),
              })),
              {
                title: `Git Timeline: ${filepath}`,
                placeHolder:
                  'Commit history for this file — select one to open the revision.',
                ignoreFocusOut: false,
              },
            )

            if (selected == null) {
              return
            }

            const selectedCommit = commits.find(
              (commit) => commit.oid.slice(0, 8) ===
                (selected.description?.split(' ')[0] ?? ''),
            )

            if (selectedCommit != null) {
              await openRevision(filepath, selectedCommit)
            }
          } catch (error) {
            console.error(
              '[Dataverse IDE] Git file history lookup failed.',
              error,
            )

            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to show file history: ${error.message}`
                : 'Unable to show file history.',
            )
          }
        },
      )

      const syncCommand = vscode.commands.registerCommand(
        'dataverseGit.sync',
        async () => {
          if (credentialProvider == null) {
            await vscode.window.showWarningMessage(
              'Git remote credentials are not configured for this workspace type.',
            )

            return
          }

          const remoteName = await selectRemoteForSync('Git: Sync', 'pull')

          if (remoteName == null) {
            return
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Syncing with ${remoteName}…`,
              cancellable: false,
            },
            async () => {
              try {
                await pullRemote(workspaceHandle, remoteName, {
                  credentialsProvider: credentialProvider,
                  fastForwardOnly: true,
                })

                await markFetchedNow()
              } catch (pullError) {
                /*
                 * Desktop VS Code syncs with a merge/rebase fallback; here a
                 * diverged branch can still be pushed explicitly, so only
                 * log the failed fast-forward.
                 */
                console.warn(
                  '[Dataverse IDE] Fast-forward pull during sync did not apply.',
                  pullError,
                )
              }

              await pushRemote(workspaceHandle, remoteName, {
                credentialsProvider: credentialProvider,
              })

              await refresh()
            },
          )
        },
      )

      async function selectRemoteForSync(
        operationTitle: string,
        operationKey: 'pull' | 'push',
      ): Promise<string | undefined> {
        const remotes = await listRemotes(workspaceHandle)

        if (remotes.length === 0) {
          await vscode.window.showWarningMessage(
            `Add a remote before ${operationKey === 'pull' ? 'pulling' : 'pushing'}. Use "Git: Add Remote".`,
          )

          return undefined
        }

        if (remotes.length === 1) {
          return remotes[0].name
        }

        const selected = await vscode.window.showQuickPick(
          remotes.map((remote) => ({
            label: remote.name,
            description: remote.url,
            name: remote.name,
          })),
          {
            title: operationTitle,
            placeHolder: 'Select a remote.',
            ignoreFocusOut: true,
          },
        )

        return selected?.name
      }

      const cloneCommand = vscode.commands.registerCommand(
        'dataverseGit.clone',
        async () => {
          const remoteUrl = await vscode.window.showInputBox({
            title: 'Clone Git Repository',
            prompt: 'Enter the HTTPS remote URL to clone.',
            placeHolder: 'https://gitlab.com/user/repo.git',
            ignoreFocusOut: true,
          })

          if (remoteUrl == null || remoteUrl.trim().length === 0) {
            return
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Clone "${remoteUrl.trim()}" into the current workspace folder? Opening a non-empty workspace will mix the clone with existing files.`,
            {
              modal: true,
            },
            'Clone Here',
          )

          if (confirmation !== 'Clone Here') {
            return
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Cloning repository…',
              cancellable: false,
            },
            async () => {
              await cloneRepository(workspaceHandle, remoteUrl.trim(), {
                credentialsProvider: credentialProvider,
                depth: 50,
              })

              await refresh()
            },
          )

          await vscode.window.showInformationMessage(
            `Cloned "${remoteUrl.trim()}" into the workspace.`,
          )
        },
      )

      const addRemoteCommand = vscode.commands.registerCommand(
        'dataverseGit.addRemote',
        async () => {
          const remoteName =
            (await vscode.window.showInputBox({
              title: 'Add Git Remote',
              prompt: 'Enter a name for the remote.',
              value: 'origin',
              ignoreFocusOut: true,
            })) ?? undefined

          if (remoteName == null || remoteName.trim().length === 0) {
            return
          }

          const remoteUrl = await vscode.window.showInputBox({
            title: 'Add Git Remote',
            prompt: 'Enter the HTTPS URL of the remote repository.',
            placeHolder: 'https://github.com/user/repo.git',
            ignoreFocusOut: true,
          })

          if (remoteUrl == null || remoteUrl.trim().length === 0) {
            return
          }

          try {
            await addRemote(
              workspaceHandle,
              remoteName.trim(),
              remoteUrl.trim(),
            )

            await refresh()

            await vscode.window.showInformationMessage(
              `Added remote "${remoteName.trim()}" -> ${remoteUrl.trim()}.`,
            )
          } catch (error) {
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to add remote: ${error.message}`
                : 'Unable to add remote.',
            )
          }
        },
      )

      const removeRemoteCommand = vscode.commands.registerCommand(
        'dataverseGit.removeRemote',
        async () => {
          try {
            const remotes = await listRemotes(workspaceHandle)

            if (remotes.length === 0) {
              await vscode.window.showInformationMessage(
                'This repository has no remotes configured.',
              )

              return
            }

            const selected = await vscode.window.showQuickPick(
              remotes.map((remote: GitRemote) => ({
                label: remote.name,
                description: remote.url,
                name: remote.name,
              })),
              {
                title: 'Remove Git Remote',
                placeHolder: 'Select a remote to remove.',
                ignoreFocusOut: true,
              },
            )

            if (selected == null) {
              return
            }

            await deleteRemote(workspaceHandle, selected.name)

            await refresh()

            await vscode.window.showInformationMessage(
              `Removed remote "${selected.name}".`,
            )
          } catch (error) {
            await vscode.window.showErrorMessage(
              error instanceof Error
                ? `Unable to remove remote: ${error.message}`
                : 'Unable to remove remote.',
            )
          }
        },
      )

      const fetchCommand = vscode.commands.registerCommand(
        'dataverseGit.fetch',
        async () => {
          if (credentialProvider == null) {
            await vscode.window.showWarningMessage(
              'Git remote credentials are not configured for this workspace type.',
            )

            return
          }

          const remoteName = await selectRemoteForSync('Git: Fetch', 'pull')

          if (remoteName == null) {
            return
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Fetching from ${remoteName}…`,
              cancellable: false,
            },
            async () => {
              await fetchRemote(workspaceHandle, remoteName, {
                credentialsProvider: credentialProvider,
              })

              await markFetchedNow()
            },
          )

          await refresh()

          await vscode.window.showInformationMessage(
            `Fetched from "${remoteName}".`,
          )
        },
      )

      const pullCommand = vscode.commands.registerCommand(
        'dataverseGit.pull',
        async () => {
          if (credentialProvider == null) {
            await vscode.window.showWarningMessage(
              'Git remote credentials are not configured for this workspace type.',
            )

            return
          }

          const remoteName = await selectRemoteForSync('Git: Pull', 'pull')

          if (remoteName == null) {
            return
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Pulling from ${remoteName}…`,
              cancellable: false,
            },
            async () => {
              await pullRemote(workspaceHandle, remoteName, {
                credentialsProvider: credentialProvider,
                fastForwardOnly: true,
              })

              await markFetchedNow()

              await refresh()
            },
          )

          await vscode.window.showInformationMessage(
            `Pulled from "${remoteName}".`,
          )
        },
      )

      const pushCommand = vscode.commands.registerCommand(
        'dataverseGit.push',
        async () => {
          if (credentialProvider == null) {
            await vscode.window.showWarningMessage(
              'Git remote credentials are not configured for this workspace type.',
            )

            return
          }

          const remoteName = await selectRemoteForSync('Git: Push', 'push')

          if (remoteName == null) {
            return
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Pushing to ${remoteName}…`,
              cancellable: false,
            },
            async () => {
              await pushRemote(workspaceHandle, remoteName, {
                credentialsProvider: credentialProvider,
              })
            },
          )

          await vscode.window.showInformationMessage(
            `Pushed to "${remoteName}".`,
          )
        },
      )

      const forgetCredentialsCommand = vscode.commands.registerCommand(
        'dataverseGit.forgetCredentials',
        async () => {
          if (options?.credentialStore == null) {
            await vscode.window.showInformationMessage(
              'No secret storage is available in this workspace mode.',
            )

            return
          }

          const remotes = await listRemotes(workspaceHandle)

          if (remotes.length === 0) {
            await vscode.window.showInformationMessage(
              'Add a remote first to know which credentials to forget.',
            )

            return
          }

          const selected = await vscode.window.showQuickPick(
            remotes.map((remote: GitRemote) => ({
              label: remote.name,
              description: remote.url,
              url: remote.url,
            })),
            {
              title: 'Forget Stored Remote Credentials',
              placeHolder: 'Select the remote whose credentials should be forgotten.',
              ignoreFocusOut: true,
            },
          )

          if (selected == null) {
            return
          }

          await forgetCredentials(options.credentialStore, selected.url)

          await vscode.window.showInformationMessage(
            `Forgotten stored credentials for "${selected.url}".`,
          )
        },
      )

      sourceControl.acceptInputCommand = {
        command: 'dataverseGit.commit',
        title: 'Commit',
        tooltip: 'Commit staged changes',
      }

      /*
       * Desktop-style editor gutter diff bars: a quick diff provider resolves
       * each working-tree file to its (staged) HEAD revision, served through
       * the dataverse-git-history content provider.
       */
      sourceControl.quickDiffProvider = {
        async provideOriginalResource(uri) {
          if (uri.scheme !== rootUri.scheme) {
            return undefined
          }

          const relativePath = vscode.workspace.asRelativePath(uri, false)

          if (
            relativePath.length === 0 ||
            relativePath.startsWith('../') ||
            relativePath.startsWith('..\\') ||
            relativePath.startsWith('.git/') ||
            relativePath.replaceAll('\\', '/').includes('/.git/')
          ) {
            return undefined
          }

          const normalPath = relativePath.replaceAll('\\', '/')

          const headCommit = await getHeadCommit(workspaceHandle)

          if (headCommit == null) {
            return undefined
          }

          const blob = await readBlobAt(workspaceHandle, headCommit, normalPath)

          /*
           * Untracked/new files have no original version — the quick diff
           * gutter renders nothing for them (like desktop VS Code for files
           * with no HEAD version).
           */
          if (blob == null) {
            return undefined
          }

          return vscode.Uri.from({
            scheme: historyScheme,
            path: `/${normalPath.split('/').pop() ?? normalPath}`,
            query: `oid=${headCommit}&path=${encodeURIComponent(normalPath)}`,
          })
        },
      }
  
    /*
     * The IDE's current autosave implementation saves regular workspace files.
     * Refresh after each save, with a short debounce to avoid repeated Git index
     * scans during rapid edits.
     */
    const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
      if (
        document.uri.scheme === 'file' &&
        vscode.workspace.getWorkspaceFolder(document.uri) != null
      ) {
        scheduleRefresh()
      }
    })

    /*
     * Auto-fetch (dataverseIde.git.autoFetchMinutes): periodically fetch from
     * the first configured remote so ahead/behind counts stay meaningful,
     * like git.autofetch. 0 (default) disables it.
     */
    let autoFetchTimer: number | undefined

    function restartAutoFetch(): void {
      if (autoFetchTimer != null) {
        window.clearInterval(autoFetchTimer)
        autoFetchTimer = undefined
      }

      const config = vscode.workspace.getConfiguration(
        'dataverseIde.git',
        rootUri,
      )

      const minutes = config.get<number>('autoFetchMinutes', 0)

      if (!(minutes > 0)) {
        return
      }

      const intervalMs = minutes * 60_000

      autoFetchTimer = window.setInterval(() => {
        void (async () => {
          try {
            const snapshot = await getGitRepositorySnapshot(workspaceHandle)

            if (!snapshot.isRepository) {
              return
            }

            if (credentialProvider == null) {
              return
            }

            const remotes = await listRemotes(workspaceHandle)

            if (remotes.length === 0) {
              return
            }

            await fetchRemote(workspaceHandle, remotes[0].name, {
              credentialsProvider: credentialProvider,
            })

            await markFetchedNow()
            await refresh()
          } catch (autoFetchError) {
            console.warn(
              '[Dataverse IDE] Auto-fetch failed.',
              autoFetchError,
            )
          }
        })()
      }, intervalMs)
    }

    const autoFetchConfigListener =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dataverseIde.git')) {
          restartAutoFetch()
        }
      })

    restartAutoFetch()
  
    await refresh()
  
    installedController = {
      refresh,
  
      dispose() {
        if (refreshTimer != null) {
          window.clearTimeout(refreshTimer)
        }

        if (autoFetchTimer != null) {
          window.clearInterval(autoFetchTimer)
        }
      
        saveListener.dispose()
        autoFetchConfigListener.dispose()

        fileDecorationProvider.dispose()
        historyContentProvider.dispose()
        showFileHistoryCommand.dispose()
        syncCommand.dispose()
        stageSelectedLinesCommand.dispose()
        discardSelectedLinesCommand.dispose()
        commitAmendCommand.dispose()
        addToGitignoreCommand.dispose()

        initializeCommand.dispose()
        refreshCommand.dispose()
        stageCommand.dispose()
        stageAllCommand.dispose()
        unstageCommand.dispose()
        unstageAllCommand.dispose()
        discardCommand.dispose()
        discardAllCommand.dispose()
        openChangesCommand.dispose()
        commitCommand.dispose()
        createBranchCommand.dispose()
        switchBranchCommand.dispose()
        deleteBranchCommand.dispose()
        showHistoryCommand.dispose()
        cloneCommand.dispose()
        addRemoteCommand.dispose()
        removeRemoteCommand.dispose()
        fetchCommand.dispose()
        pullCommand.dispose()
        pushCommand.dispose()
        forgetCredentialsCommand.dispose()
      
        sourceControl.dispose()
      
        installedController = undefined
      }
    }
  
    return installedController
  }

import type { ExtensionContext, IdeExtension } from '../api.js'
import type { GitCredentialStore } from './credentials.js'

/*
 * Registry adapter: the original install function is preserved for direct
 * callers, but the extension registry activates features through `default`.
 */
export default {
  id: 'git',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const handle = context.workspaceDirectoryHandle

    if (handle == null) {
      throw new Error(
        'The git extension requires a local workspace directory handle.',
      )
    }

    const credentialStore: GitCredentialStore = {
      get: (key) => context.secrets.get(key),
      set: (key, value) => context.secrets.set(key, value),
      remove: (key) => context.secrets.remove(key),
    }

    const controller = await installDataverseGitExtension(handle, context.workspaceRootUri, {
      credentialStore,
      metadataStore: {
        get: (key) => context.secrets.get(key),
        set: (key, value) => context.secrets.set(key, value),
        remove: (key) => context.secrets.remove(key),
      },
    })

    return {
      dispose() {
        controller.dispose()
      },
    }
  },
} satisfies IdeExtension
