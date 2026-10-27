import type * as vscodeType from 'vscode'

import {
  contributeCommandManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
  IdeExtensionHttp,
  IdeExtensionSecretStore,
} from '../api.js'

import {
  GitLabClient,
  projectPathFromRemoteUrl,
  type GitLabIssue,
  type GitLabMergeRequest,
  type GitLabPipeline,
  type GitLabProject,
} from './client.js'

/*
 * GitLab extension (REST API v4, PAT auth - fully separate from the git
 * extension's git-transport credentials).
 *
 * Configuration (workspace settings):
 *   dataverseIde.gitlab.baseUrl   e.g. https://gitlab.com or self-hosted
 *   dataverseIde.gitlab.project   "group/project" (defaulted from origin)
 *
 * Token: stored in secret storage via "GitLab: Connect".
 */

const COMMAND_CONNECT = 'dataverseIde.gitlab.connect'
const COMMAND_SHOW_MRS = 'dataverseIde.gitlab.showMergeRequests'
const COMMAND_SHOW_ISSUES = 'dataverseIde.gitlab.showIssues'
const COMMAND_SHOW_PIPELINES = 'dataverseIde.gitlab.showPipelines'
const COMMAND_CREATE_MR = 'dataverseIde.gitlab.createMergeRequest'

const CONFIG_SECTION = 'dataverseIde.gitlab'

function getBaseUrl(vscode: typeof vscodeType): string {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('baseUrl', 'https://gitlab.com')
    .trim()
}

async function readGitRemoteUrl(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(rootUri, '.git', 'config'),
    )

    const text = new TextDecoder().decode(bytes)

    const match = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/s.exec(text)

    return match?.[1]
  } catch {
    return undefined
  }
}

type ProjectResolution = {
  project: string
  origin?: { host: string; path: string }
}

async function resolveProject(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<ProjectResolution | undefined> {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>('project', '')
    .trim()

  const remoteUrl = await readGitRemoteUrl(vscode, rootUri)
  const origin = remoteUrl ? projectPathFromRemoteUrl(remoteUrl) : undefined

  if (configured.length > 0) {
    return { project: configured, origin: origin ?? undefined }
  }

  if (origin != null) {
    return { project: origin.path, origin }
  }

  return undefined
}

function formatTimestamp(value?: string): string {
  if (value == null) {
    return ''
  }

  const timestamp = new Date(value).getTime()

  if (Number.isNaN(timestamp)) {
    return ''
  }

  return new Date(timestamp).toLocaleString()
}

export default {
  id: 'gitlab',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel, secrets, http } = context

    await contributeCommandManifest({
      id: 'gitlab',
      displayName: 'Dataverse IDE GitLab',
      description: 'GitLab REST API integration (PAT-based).',
      commands: [
        {
          command: 'dataverseIde.gitlab.connect',
          title: 'GitLab: Connect (Personal Access Token)',
        },
        {
          command: 'dataverseIde.gitlab.showMergeRequests',
          title: 'GitLab: Show Merge Requests',
        },
        {
          command: 'dataverseIde.gitlab.showIssues',
          title: 'GitLab: Show Issues',
        },
        {
          command: 'dataverseIde.gitlab.showPipelines',
          title: 'GitLab: Show Pipelines',
        },
        {
          command: 'dataverseIde.gitlab.createMergeRequest',
          title: 'GitLab: New Merge Request',
        },
      ],
    })

    async function ensureToken(): Promise<string | undefined> {
      let token = await secrets.get('token')

      if (token != null && token.length > 0) {
        return token
      }

      await vscode.window.showInformationMessage(
        'GitLab: connect with a personal access token first.',
      )

      token = await promptForToken()

      if (token == null || token.length === 0) {
        return undefined
      }

      await secrets.set('token', token)

      return token
    }

    async function promptForToken(): Promise<string | undefined> {
      const token = await vscode.window.showInputBox({
        title: 'GitLab: Connect',
        prompt:
          'Paste a GitLab personal access token (scopes: read_api, write_repository).',
        password: true,
        ignoreFocusOut: true,
      })

      if (token == null || token.trim().length === 0) {
        return undefined
      }

      await secrets.set('token', token.trim())

      const baseUrl = getBaseUrl(vscode)

      try {
        const client = new GitLabClient({
          baseUrl,
          token: token.trim(),
          http,
        })

        const user = await client.getCurrentUser()

        await vscode.window.showInformationMessage(
          `GitLab: connected as ${user.username} (${baseUrl}).`,
        )
      } catch (error) {
        outputChannel.appendLine(
          `[gitlab] token validation failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      return token.trim()
    }

    const connectCommand = vscode.commands.registerCommand(
      COMMAND_CONNECT,
      async () => {
        const token = await promptForToken()

        if (token == null) {
          outputChannel.show(true)
          outputChannel.appendLine('[gitlab] connect cancelled.')
        }
      },
    )

    /*
     * Shared "ensure ready" helper: validates token + project resolution and
     * reports actionable error messages.
     */
    async function ensureClient(): Promise<
      | {
          client: GitLabClient
          project: ProjectResolution
        }
      | undefined
    > {
      const token = await ensureToken()

      if (token == null) {
        return undefined
      }

      const project = await resolveProject(vscode, context.workspaceRootUri)

      if (project == null) {
        await vscode.window.showErrorMessage(
          'GitLab: cannot determine the project. Set "dataverseIde.gitlab.project" or add a remote (origin) first.',
        )

        return undefined
      }

      const client = new GitLabClient({
        baseUrl: getBaseUrl(vscode),
        token,
        http,
      })

      return { client, project }
    }

    type MrPick = { label: string; description: string; detail: string; url: string }

    const showMergeRequestsCommand = vscode.commands.registerCommand(
      COMMAND_SHOW_MRS,
      async () => {
        const ready = await ensureClient()

        if (ready == null) {
          return
        }

        const { client, project } = ready

        try {
          const mergeRequests: GitLabMergeRequest[] =
            await client.listMergeRequests(project.project, {
              state: 'opened',
            })

          if (mergeRequests.length === 0) {
            await vscode.window.showInformationMessage(
              `GitLab: no open merge requests on ${project.project}.`,
            )

            return
          }

          const selected = await vscode.window.showQuickPick<MrPick>(
            mergeRequests.map((mr) => ({
              label: `!${mr.iid} ${mr.title}`,
              description: `${mr.state} · ${mr.source_branch} → ${mr.target_branch}`,
              detail: `${mr.author?.name ?? ''} · updated ${formatTimestamp(mr.updated_at)}`,
              url: mr.web_url,
            })),
            {
              title: `GitLab: Merge Requests (${project.project})`,
              placeHolder: 'Select a merge request to open it in GitLab.',
              ignoreFocusOut: true,
            },
          )

          if (selected != null) {
            void vscode.env.openExternal(vscode.Uri.parse(selected.url))
          }
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          )
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            'GitLab: failed to list merge requests (see GitLab output).',
          )
        }
      },
    )

    const showIssuesCommand = vscode.commands.registerCommand(
      COMMAND_SHOW_ISSUES,
      async () => {
        const ready = await ensureClient()

        if (ready == null) {
          return
        }

        const { client, project } = ready

        try {
          const issues: GitLabIssue[] = await client.listIssues(
            project.project,
            { state: 'opened' },
          )

          if (issues.length === 0) {
            await vscode.window.showInformationMessage(
              `GitLab: no open issues on ${project.project}.`,
            )

            return
          }

          const selected = await vscode.window.showQuickPick<MrPick>(
            issues.map((issue) => ({
              label: `#${issue.iid} ${issue.title}`,
              description: issue.state,
              detail: `${issue.author?.name ?? ''} · created ${formatTimestamp(issue.created_at)}`,
              url: issue.web_url,
            })),
            {
              title: `GitLab: Issues (${project.project})`,
              placeHolder: 'Select an issue to open it in GitLab.',
              ignoreFocusOut: true,
            },
          )

          if (selected != null) {
            void vscode.env.openExternal(vscode.Uri.parse(selected.url))
          }
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          )
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            'GitLab: failed to list issues (see GitLab output).',
          )
        }
      },
    )

    const showPipelinesCommand = vscode.commands.registerCommand(
      COMMAND_SHOW_PIPELINES,
      async () => {
        const ready = await ensureClient()

        if (ready == null) {
          return
        }

        const { client, project } = ready

        try {
          const pipelines: GitLabPipeline[] = await client.listPipelines(
            project.project,
          )

          if (pipelines.length === 0) {
            await vscode.window.showInformationMessage(
              `GitLab: no pipelines on ${project.project}.`,
            )

            return
          }

          const selected = await vscode.window.showQuickPick<MrPick>(
            pipelines.map((pipeline) => ({
              label: `#${pipeline.id} ${pipeline.status}`,
              description: pipeline.ref ?? '',
              detail: `finished ${formatTimestamp(pipeline.finished_at)}`,
              url: pipeline.web_url,
            })),
            {
              title: `GitLab: Pipelines (${project.project})`,
              placeHolder: 'Select a pipeline to open it in GitLab.',
              ignoreFocusOut: true,
            },
          )

          if (selected != null) {
            void vscode.env.openExternal(vscode.Uri.parse(selected.url))
          }
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          )
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            'GitLab: failed to list pipelines (see GitLab output).',
          )
        }
      },
    )

    const createMergeRequestCommand = vscode.commands.registerCommand(
      COMMAND_CREATE_MR,
      async () => {
        const ready = await ensureClient()

        if (ready == null) {
          return
        }

        const { client, project } = ready

        let currentBranch: string | undefined

        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(context.workspaceRootUri, '.git', 'HEAD'),
          )

          const head = new TextDecoder().decode(bytes).trim()

          const match = /^ref: refs\/heads\/(.+)$/.exec(head)

          currentBranch = match?.[1]
        } catch {
          currentBranch = undefined
        }

        const sourceBranch = await vscode.window.showInputBox({
          title: 'GitLab: New Merge Request',
          prompt: 'Source branch.',
          value: currentBranch ?? '',
          ignoreFocusOut: true,
        })

        if (sourceBranch == null || sourceBranch.trim().length === 0) {
          return
        }

        const targetBranch = await vscode.window.showInputBox({
          title: 'GitLab: New Merge Request',
          prompt: 'Target branch.',
          value: 'main',
          ignoreFocusOut: true,
        })

        if (targetBranch == null || targetBranch.trim().length === 0) {
          return
        }

        const title = await vscode.window.showInputBox({
          title: 'GitLab: New Merge Request',
          prompt: 'Merge request title.',
          ignoreFocusOut: true,
        })

        if (title == null || title.trim().length === 0) {
          return
        }

        try {
          const mr: GitLabMergeRequest =
            await client.createMergeRequest(project.project, {
              sourceBranch: sourceBranch.trim(),
              targetBranch: targetBranch.trim(),
              title: title.trim(),
              removeSourceBranch: true,
            })

          await vscode.window.showInformationMessage(
            `GitLab: created merge request !${mr.iid} "${mr.title}".`,
          )

          void vscode.env.openExternal(vscode.Uri.parse(mr.web_url))
        } catch (error) {
          outputChannel.appendLine(
            `[gitlab] ${error instanceof Error ? error.message : String(error)}`,
          )
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            'GitLab: failed to create the merge request (see GitLab output).',
          )
        }
      },
    )

    outputChannel.appendLine('[gitlab] extension activated.')

    return {
      dispose() {
        connectCommand.dispose()
        showMergeRequestsCommand.dispose()
        showIssuesCommand.dispose()
        showPipelinesCommand.dispose()
        createMergeRequestCommand.dispose()
      },
    }
  },
} satisfies IdeExtension

export type { GitLabProject }
export type { IdeExtensionHttp, IdeExtensionSecretStore }
