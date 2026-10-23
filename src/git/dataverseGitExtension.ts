import {
    ExtensionHostKind,
    registerExtension,
  } from '@codingame/monaco-vscode-api/extensions'
  import type * as vscodeType from 'vscode'
  
  import {
    createCommit,
    getGitRepositorySnapshot,
    stageAll,
    stagePaths,
    unstageAll,
    unstagePaths,
    type GitFileStatus,
    type GitTreeEntry,
  } from './gitService.js'
  
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
  ): Promise<DataverseGitScmController> {
    if (installedController != null) {
      return installedController
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
            commands: [
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
            ],
          
            menus: {
              'scm/resourceState/context': [
                {
                  command: 'dataverseGit.stage',
                  when: 'scmProvider == dataverseGit && scmResourceState == dataverseGit.change',
                  group: 'inline@1',
                },
                {
                  command: 'dataverseGit.unstage',
                  when: 'scmProvider == dataverseGit && scmResourceState == dataverseGit.staged',
                  group: 'inline@1',
                },
              ],
          
              'scm/title': [
                {
                  command: 'dataverseGit.refresh',
                  when: 'scmProvider == dataverseGit',
                  group: 'navigation@1',
                },
                {
                  command: 'dataverseGit.stageAll',
                  when: 'scmProvider == dataverseGit',
                  group: 'navigation@2',
                },
                {
                  command: 'dataverseGit.unstageAll',
                  when: 'scmProvider == dataverseGit',
                  group: 'navigation@3',
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
      'Git status is read-only until staging and commit are enabled.'
  
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
  
        if (!snapshot.isRepository) {
          sourceControl.count = 0
          changesGroup.resourceStates = []
          stagedGroup.resourceStates = []
  
          sourceControl.statusBarCommands = [
            {
              command: 'dataverseGit.refresh',
              title: '$(refresh) Not a Git Repository',
              tooltip: 'Refresh Git repository status',
            },
          ]
  
          return
        }
  
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
            command: 'dataverseGit.refresh',
            title: `$(git-branch) ${branchLabel}`,
            tooltip: 'Refresh Git repository status',
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
        const name = await vscode.window.showInputBox({
          title: 'Git Commit Author',
          prompt: 'Enter the commit author name.',
          placeHolder: 'Example: Ada Lovelace',
          ignoreFocusOut: true,
        })
      
        if (name == null || name.trim().length === 0) {
          return undefined
        }
      
        const email = await vscode.window.showInputBox({
          title: 'Git Commit Author',
          prompt: 'Enter the commit author email address.',
          placeHolder: 'Example: ada@example.mil',
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

        refreshCommand.dispose()
        stageCommand.dispose()
        stageAllCommand.dispose()
        unstageCommand.dispose()
        unstageAllCommand.dispose()
        commitCommand.dispose()
        
        sourceControl.dispose()
  
        installedController = undefined
      },
    }
  
    return installedController
  }