import {
    ExtensionHostKind,
    registerExtension,
  } from '@codingame/monaco-vscode-api/extensions'
  import type * as vscodeType from 'vscode'
  
  import {
    addRemote,
    cloneRepository,
    createBranch,
    createCommit,
    deleteLocalBranch,
    deleteRemote,
    fetchRemote,
    getGitRepositorySnapshot,
    getRecentCommits,
    initializeRepository,
    listLocalBranches,
    listRemotes,
    pullRemote,
    pushRemote,
    stageAll,
    stagePaths,
    switchBranch,
    unstageAll,
    unstagePaths,
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
  
    return {
      resourceUri,
      contextValue:
      group === 'changes'
        ? 'dataverseGit.change'
        : 'dataverseGit.staged',
  
        decorations: {
            tooltip: getStatusTooltip(entry.status),
            iconPath: new vscode.ThemeIcon(
              getStatusIcon(entry.status),
            ),
            strikeThrough: deleted,
            faded: deleted,
          },
  
      /*
       * Deleted files cannot be opened from the working tree, but all other
       * resources should open normally when selected in Source Control.
       */
      command: deleted
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
              },
              {
                command: 'dataverseGit.stageAll',
                title: 'Git: Stage All Changes',
              },
              {
                command: 'dataverseGit.unstage',
                title: 'Git: Unstage Changes',
              },
              {
                command: 'dataverseGit.unstageAll',
                title: 'Git: Unstage All Changes',
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
          
            menus: {
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
                  command: 'dataverseGit.stageAll',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@2',
                },
                {
                  command: 'dataverseGit.unstageAll',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@3',
                },
                {
                  command: 'dataverseGit.createBranch',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@4',
                },
                {
                  command: 'dataverseGit.switchBranch',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@5',
                },
                {
                  command: 'dataverseGit.pull',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@6',
                },
                {
                  command: 'dataverseGit.push',
                  when: 'scmProvider == dataverseGit && dataverseGit.isRepository',
                  group: 'navigation@7',
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
      },
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
  
        const branchLabel = snapshot.branch ?? 'DETACHED'
  
        sourceControl.statusBarCommands = [
            {
              command: 'dataverseGit.switchBranch',
              title: `$(git-branch) ${snapshot.branch ?? 'DETACHED'}`,
              tooltip: 'Switch Git branch',
            },
            {
              command: 'dataverseGit.refresh',
              title: '$(refresh)',
              tooltip: 'Refresh Git status',
            },
          ]
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
      
      const commitCommand = vscode.commands.registerCommand(
        'dataverseGit.commit',
        async () => {
          const message = sourceControl.inputBox.value.trim()
      
          if (message.length === 0) {
            await vscode.window.showWarningMessage(
              'Enter a commit message before committing.',
            )
      
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
      
            const selected = await vscode.window.showQuickPick(
              branches.map((branch) => ({
                label: branch.name,
                description: branch.current
                  ? 'Current branch'
                  : undefined,
                branch,
              })),
              {
                title: 'Switch Git Branch',
                placeHolder: 'Select a local branch.',
                ignoreFocusOut: true,
              },
            )
      
            if (selected == null || selected.branch.current) {
              return
            }
      
            await switchBranch(
              workspaceHandle,
              selected.branch.name,
            )
      
            await refresh()
      
            await vscode.window.showInformationMessage(
              `Switched to "${selected.branch.name}".`,
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
      
            await vscode.window.showQuickPick(
              commits.map((commit) => ({
                label: `${commit.oid.slice(0, 8)} ${commit.message}`,
                description: `${commit.authorName} <${commit.authorEmail}>`,
                detail: new Date(
                  commit.timestamp * 1000,
                ).toLocaleString(),
              })),
              {
                title: 'Git Commit History',
                placeHolder: 'Most recent commits',
                ignoreFocusOut: true,
              },
            )
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
       * Remote selection helper: quick pick among configured remotes, or
       * prompt to create one if none exist. Returns undefined if the user
       * cancels or the remote was created (re-enter via quick pick).
       */
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
            },
          )

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
  
    await refresh()
  
    installedController = {
      refresh,
  
      dispose() {
        if (refreshTimer != null) {
          window.clearTimeout(refreshTimer)
        }
      
        saveListener.dispose()
      
        initializeCommand.dispose()
        refreshCommand.dispose()
        stageCommand.dispose()
        stageAllCommand.dispose()
        unstageCommand.dispose()
        unstageAllCommand.dispose()
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
    })

    return {
      dispose() {
        controller.dispose()
      },
    }
  },
} satisfies IdeExtension
